'use strict';
/* server/store/journal.js —— append-only 领域事件日志（D-129 §6.1/§6.2/§6.3/§6.7；真源）
 * 职责：
 *   - 分段 `journal/<YYYY-MM>.jsonl`（按月；§6.7 的 `2026-09.jsonl` 具体形式，段名可字典序 = 时间序）
 *   - group commit：同一事件循环内的多次 append 合并为一次 write + 一次 fsync（默认 fsyncMode=batch）
 *   - seq 分配（全局单调）+ 重放 + 末行半写截断 + 按月压缩检查点（checkpoint）
 * 依赖：node:fs/path（本目录是唯一允许 fs 的目录）、shared/log.js（注入 logger）、同层 fsatomic。
 * 事件（docs/interfaces.md §6，通道 store）：store.journal.append(debug) / store.journal.flush(trace)
 *   / store.journal.truncate(warn) / store.journal.compact(info) / store.error(error)。
 */
const fs = require('node:fs');
const path = require('node:path');
const { nullLogger } = require('../../shared/log.js');
const { StoreError } = require('./errors.js');
const { deepClone } = require('./canonical.js');
const { NON_COMPACTABLE } = require('./archive.js');
const fsatomic = require('./fsatomic.js');

const RECORD_VERSION = 1;
const SEGMENT_RE = /^(\d{4})-(\d{2})\.jsonl$/;
const CHECKPOINT_RE = /^(\d{4})-(\d{2})\.checkpoint\.json$/;
const MS_PER_DAY = 86400000;
const DEFAULT_BUFFER = 1048576;

function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// 解析一段 journal 文本：返回 {records, truncated, badLine}
//   - 末行无结尾换行 → 半写，丢弃（§6.4 步骤 4）
//   - 中间行 JSON 解析失败 → 不可自动修复的损坏（badLine）
function parseSegmentText(text) {
  const records = [];
  if (text === '') return { records, truncated: false, badLine: null };
  const parts = text.split('\n');
  let lines;
  let truncated = false;
  if (parts[parts.length - 1] === '') {
    lines = parts.slice(0, -1);
  } else {
    lines = parts.slice(0, -1); // 丢弃缺结尾换行的末行
    truncated = true;
  }
  let badLine = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (err) {
      badLine = i;
      break;
    }
    records.push(rec);
  }
  if (badLine !== null && badLine >= lines.length - 1) {
    return { records, truncated: true, badLine: null }; // 只有坏尾行 → 截断即可
  }
  return { records, truncated, badLine };
}

function serializeRecords(records) {
  if (records.length === 0) return '';
  return `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
}

function createJournal(options) {
  const opts = options || {};
  const dir = opts.dir;
  if (!dir) throw new StoreError('store_internal', 'journal 需要 dir');
  const log = opts.logger || nullLogger;
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const cfg = opts.config || {};
  const fsyncMode = cfg.fsyncMode === 'sync' ? 'sync' : 'batch';
  const bufferBytes = Number.isInteger(cfg.bufferBytes) && cfg.bufferBytes > 0 ? cfg.bufferBytes : DEFAULT_BUFFER;

  let seq = 0;
  let opened = false;
  let pending = [];      // [{record, line, bytes}]
  let pendingBytes = 0;
  let waiters = [];      // [{resolve, reject, record}]
  let scheduled = null;  // setImmediate 句柄
  let segments = [];     // [{key, file, maxSeq, count, bytes}]
  let checkpoints = [];  // [{key, file, seq, at, perPlayer}]
  const battles = new Map(); // battleId → record（最近一次为准；用于回放定位）
  let fullyIndexed = false;  // load() 是否已把**全部段**的 battleId 收进内存索引（见 findBattle）

  const segmentFileOf = (key) => path.join(dir, `${key}.jsonl`);
  const checkpointFileOf = (key) => path.join(dir, `${key}.checkpoint.json`);

  function listKeys(re) {
    const keys = [];
    for (const entry of fsatomic.listDirFiles(dir)) {
      if (!entry.isFile()) continue;
      const m = re.exec(entry.name);
      if (m) keys.push(`${m[1]}-${m[2]}`);
    }
    return keys.sort();
  }

  function readSegmentRecords(key) {
    const file = segmentFileOf(key);
    if (!fsatomic.pathExists(file)) return [];
    const parsed = parseSegmentText(fsatomic.readText(file));
    if (parsed.badLine !== null) {
      throw new StoreError('store_corrupt',
        `journal 段 ${key}.jsonl 第 ${parsed.badLine + 1} 行损坏且不是末行（无法自动截断）`,
        [{ path: file, code: 'store_corrupt', message: `第 ${parsed.badLine + 1} 行` }]);
    }
    return parsed.records;
  }

  // 内存 battle 索引：**存深拷贝**（P7-6 修复的防御项）。
  // 理由：append 会把调用方的记录对象交回调用方（settleBattle 的返回值），若索引共享该引用，
  //   调用方改写返回值就会污染进程内 `findBattle` 的结果（回放/参与者校验读到被改的记录），
  //   直到重启才消失。这里存副本、取出时也给副本，杜绝双向污染。
  function trackRecord(rec) {
    if (Number.isInteger(rec.seq) && rec.seq > seq) seq = rec.seq;
    if (typeof rec.battleId === 'string' && rec.type === 'battle.recorded') battles.set(rec.battleId, deepClone(rec));
  }

  // 启动加载：扫全部分段与检查点 → 计算 maxSeq（seq 的**唯一权威来源**）→ 截断半写尾行
  function load() {
    fsatomic.ensureDir(dir);
    segments = [];
    checkpoints = [];
    seq = 0;
    battles.clear();
    let truncatedSegments = 0;
    for (const key of listKeys(SEGMENT_RE)) {
      const file = segmentFileOf(key);
      const parsed = parseSegmentText(fsatomic.readText(file));
      if (parsed.badLine !== null) {
        throw new StoreError('store_corrupt',
          `journal 段 ${key}.jsonl 第 ${parsed.badLine + 1} 行损坏且不是末行（无法自动截断）`,
          [{ path: file, code: 'store_corrupt', message: `第 ${parsed.badLine + 1} 行` }]);
      }
      if (parsed.truncated) {
        truncatedSegments += 1;
        log.warn('store', 'store.journal.truncate', `journal 段 ${key}.jsonl 存在半写尾行，已截断到最后一条完整记录`, {
          segment: key, kept: parsed.records.length,
        });
        fsatomic.writeFileAtomicSync(file, serializeRecords(parsed.records), { logger: log });
      }
      let maxSeq = 0;
      for (const rec of parsed.records) {
        trackRecord(rec);
        if (Number.isInteger(rec.seq) && rec.seq > maxSeq) maxSeq = rec.seq;
      }
      const stat = fsatomic.statSafe(file);
      segments.push({ key, file, maxSeq, count: parsed.records.length, bytes: stat ? stat.size : 0 });
    }
    for (const key of listKeys(CHECKPOINT_RE)) {
      const file = checkpointFileOf(key);
      const cp = fsatomic.readJsonSync(file, null);
      if (!cp || !Number.isInteger(cp.seq)) {
        throw new StoreError('store_corrupt', `journal 检查点 ${key}.checkpoint.json 损坏`, [
          { path: file, code: 'store_corrupt', message: '检查点不可解析或缺少 seq' },
        ]);
      }
      if (cp.seq > seq) seq = cp.seq;
      checkpoints.push({ key, file, seq: cp.seq, at: cp.at || null, perPlayer: cp.perPlayer || {} });
    }
    opened = true;
    fullyIndexed = true; // 全量段已扫完：此后"内存索引未命中"即"磁盘上也不存在"
    return { seq, segments: segments.length, checkpoints: checkpoints.length, truncatedSegments, battles: battles.size };
  }

  function flushSync() {
    if (scheduled !== null) {
      clearImmediate(scheduled);
      scheduled = null;
    }
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    const ws = waiters;
    waiters = [];
    if (batch.length === 0) {
      for (const w of ws) w.resolve(w.record);
      return;
    }
    const key = monthKey(batch[0].record.at);
    const file = segmentFileOf(key);
    let bytes = 0;
    try {
      const fd = fs.openSync(file, 'a');
      try {
        for (const item of batch) {
          fs.writeSync(fd, item.line);
          bytes += item.bytes;
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      log.error('store', 'store.error', `journal 写入失败（${key}）: ${err.code || err.message}`, {
        segment: key, count: batch.length, code: err.code || null,
      });
      const werr = new StoreError('store_write_failed', `journal 写入失败: ${err.code || err.message}`, [
        { path: file, code: 'store_write_failed', message: err.code || err.message },
      ], { cause: err });
      for (const w of ws) w.reject(werr);
      return;
    }
    let maxSeq = 0;
    for (const item of batch) {
      trackRecord(item.record);
      if (Number.isInteger(item.record.seq) && item.record.seq > maxSeq) maxSeq = item.record.seq;
    }
    let seg = segments.find((s) => s.key === key);
    if (!seg) {
      seg = { key, file, maxSeq: 0, count: 0, bytes: 0 };
      segments.push(seg);
      segments.sort((a, b) => (a.key < b.key ? -1 : 1));
    }
    seg.maxSeq = Math.max(seg.maxSeq, maxSeq);
    seg.count += batch.length;
    seg.bytes += bytes;
    log.trace('store', 'store.journal.flush', `journal flush ${batch.length} 条 → ${key}.jsonl`, {
      segment: key, count: batch.length, bytes,
    });
    for (const item of batch) {
      log.debug('store', 'store.journal.append', `journal append #${item.record.seq} ${item.record.type}`, {
        seq: item.record.seq, type: item.record.type, battleId: item.record.battleId || null,
      });
    }
    for (const w of ws) w.resolve(w.record);
  }

  function schedule() {
    if (scheduled !== null) return;
    scheduled = setImmediate(() => {
      scheduled = null;
      flushSync();
    });
  }

  // async：校验失败以 rejection 形式返回（调用方统一 try/catch/await，不混用同步抛错）
  async function append(record) {
    if (!opened) throw new StoreError('store_internal', 'journal 未 load 即 append');
    if (!record || typeof record !== 'object' || typeof record.type !== 'string') {
      throw new StoreError('bad_request', 'journal 记录必须是含 type 的对象');
    }
    // D-134/§9.1：battle.recorded 必须带 battleId（内容寻址），且同一 battleId 只能出现一次
    if (record.type === 'battle.recorded') {
      if (typeof record.battleId !== 'string' || record.battleId === '') {
        throw new StoreError('bad_request', 'battle.recorded 必须带 battleId（内容寻址，§9.1）', [
          { path: 'battleId', code: 'bad_request', message: '缺少 battleId；请用 store.settleBattle 或 ledger.buildBattleRecord 构造' },
        ]);
      }
      if (hasBattle(record.battleId)) {
        throw new StoreError('bad_request', `battleId ${record.battleId} 已存在于 journal（内容寻址幂等，不得重复记账）`, [
          { path: 'battleId', code: 'bad_request', message: '重复的 battleId' },
        ]);
      }
    }
    const rec = { ...record };
    if (Number.isInteger(rec.seq)) {
      // 显式 seq 仅用于导入/迁移：必须严格大于当前水位
      if (rec.seq <= seq) throw new StoreError('bad_request', `journal 显式 seq ${rec.seq} 不大于当前水位 ${seq}`);
      seq = rec.seq;
    } else {
      seq += 1;
      rec.seq = seq;
    }
    if (!Number.isInteger(rec.at)) rec.at = nowFn();
    if (!Number.isInteger(rec.v)) rec.v = RECORD_VERSION;
    const line = `${JSON.stringify(rec)}\n`;
    const bytes = Buffer.byteLength(line);
    pending.push({ record: rec, line, bytes });
    pendingBytes += bytes;
    const promise = new Promise((resolve, reject) => {
      waiters.push({ resolve, reject, record: rec });
    });
    if (fsyncMode === 'sync' || pendingBytes >= bufferBytes) flushSync();
    else schedule();
    return promise;
  }

  // 批量入缓冲（同一同步块内 → 触发 group commit：一次 write + 一次 fsync）
  async function appendMany(records) {
    return Promise.all(records.map((record) => append(record)));
  }

  async function flush() {
    flushSync();
  }

  async function close() {
    if (!opened) return;
    flushSync();
    opened = false;
  }

  // 顺序读取（检查点优先于同月分段；跨月按 key 字典序 = 时间序）
  function readAll(readOpts) {
    const o = readOpts || {};
    const from = Number.isInteger(o.fromSeq) ? o.fromSeq : 0;
    const to = Number.isInteger(o.toSeq) ? o.toSeq : Number.MAX_SAFE_INTEGER;
    const includeCheckpoints = o.includeCheckpoints !== false;
    const out = [];
    const keys = [...new Set([...segments.map((s) => s.key), ...checkpoints.map((c) => c.key)])].sort();
    for (const key of keys) {
      const cp = checkpoints.find((c) => c.key === key);
      if (includeCheckpoints && cp && cp.seq > from && cp.seq <= to) {
        const body = fsatomic.readJsonSync(cp.file, null);
        if (body) out.push(body);
      }
      const seg = segments.find((s) => s.key === key);
      if (seg && seg.maxSeq > from) {
        for (const rec of readSegmentRecords(key)) {
          if (rec.seq > from && rec.seq <= to) out.push(rec);
        }
      }
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  async function replay(replayOpts, fn) {
    const records = readAll(replayOpts);
    let n = 0;
    for (const rec of records) {
      await fn(rec);
      n += 1;
    }
    return n;
  }

  function hasBattle(battleId) {
    if (battles.has(battleId)) return true;
    for (const item of pending) {
      if (item.record.type === 'battle.recorded' && item.record.battleId === battleId) return true;
    }
    return false;
  }

  function findBattle(battleId) {
    const hit = battles.get(battleId);
    if (hit) return deepClone(hit);
    // P7-6 性能：load() 已把全部段的 battleId 收进 `battles`（此后每个 append 也经 trackRecord 入索引），
    //   故"内存索引未命中"即"journal 里不存在"。原实现对每次未命中都**重读并重解析全部段**
    //   （50 人压测下每次结算都是未命中 → 每次重解析 ~600KB journal，是结算成本的一大块）。
    if (fullyIndexed) return null;
    for (const seg of [...segments].sort((a, b) => (a.key < b.key ? 1 : -1))) {
      for (const rec of readSegmentRecords(seg.key)) {
        if (rec.type === 'battle.recorded' && rec.battleId === battleId) {
          battles.set(battleId, deepClone(rec));
          return deepClone(rec);
        }
      }
    }
    return null;
  }

  // 按月压缩：段内全部记录都已物化（maxSeq ≤ appliedSeq）且早于 retentionDays → 写检查点后删段
  function compact(compactOpts) {
    const o = compactOpts || {};
    const appliedSeq = Number.isInteger(o.appliedSeq) ? o.appliedSeq : seq;
    const retentionDays = Number.isInteger(o.retentionDays) ? o.retentionDays : 30;
    const aggregate = typeof o.aggregate === 'function' ? o.aggregate : null;
    const at = Number.isInteger(o.at) ? o.at : nowFn();
    const cutoffKey = monthKey(at - retentionDays * MS_PER_DAY);
    const compacted = [];
    const droppedSegments = [];
    for (const seg of [...segments]) {
      if (seg.key >= cutoffKey) continue;
      if (seg.maxSeq > appliedSeq) continue; // 仍有未物化记录 → 保留该段
      const records = readSegmentRecords(seg.key);
      // D-159/D-161：含仓库/AI 状态变更的段**保留不压缩**——这些记录承载的是状态量
      //   （开箱发放 / 装配拆卸 / AI 库），无法由段内增量无损重建，必须留在 journal 真源里。
      if (records.some((r) => r && NON_COMPACTABLE.includes(r.type))) {
        log.info('store', 'store.journal.compact.skip',
          `journal 段 ${seg.key} 含仓库/AI 变更（${records.length} 条），保留不压缩`,
          { segment: seg.key, records: records.length, reason: 'non_compactable_types' });
        continue;
      }
      const perPlayer = aggregate ? aggregate(records) : {};
      const checkpoint = {
        type: 'checkpoint', v: RECORD_VERSION, seq: seg.maxSeq, at,
        key: seg.key, records: records.length, perPlayer,
      };
      fsatomic.writeJsonAtomicSync(checkpointFileOf(seg.key), checkpoint, { logger: log, pretty: true });
      fsatomic.removeFile(seg.file);
      segments = segments.filter((s) => s.key !== seg.key);
      checkpoints.push({ key: seg.key, file: checkpointFileOf(seg.key), seq: seg.maxSeq, at, perPlayer });
      compacted.push(seg.key);
      droppedSegments.push(seg.key);
      log.info('store', 'store.journal.compact', `journal 段 ${seg.key} 已生成检查点并删除（${records.length} 条）`, {
        segment: seg.key, records: records.length, seq: seg.maxSeq,
      });
    }
    return { compacted, droppedSegments };
  }

  function stats() {
    return {
      seq,
      open: opened,
      fsyncMode,
      pending: pending.length,
      pendingBytes,
      segments: segments.map((s) => ({ key: s.key, count: s.count, maxSeq: s.maxSeq, bytes: s.bytes })),
      checkpoints: checkpoints.map((c) => ({ key: c.key, seq: c.seq, players: Object.keys(c.perPlayer).length })),
      battles: battles.size,
    };
  }

  return {
    dir,
    load,
    append,
    appendMany,
    flush,
    close,
    maxSeq: () => seq,
    isOpen: () => opened,
    readAll,
    replay,
    hasBattle,
    findBattle,
    compact,
    stats,
    segments: () => segments.map((s) => ({ ...s })),
    checkpoints: () => checkpoints.map((c) => ({ ...c })),
  };
}

module.exports = {
  RECORD_VERSION,
  SEGMENT_RE,
  CHECKPOINT_RE,
  MS_PER_DAY,
  monthKey,
  parseSegmentText,
  serializeRecords,
  createJournal,
};
