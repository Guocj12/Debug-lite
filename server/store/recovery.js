'use strict';
/* server/store/recovery.js —— 启动崩溃恢复（D-129 §6.4）
 * 权威：docs/systems/11-account-store.md §6.4（五步流程）。
 * 顺序（实现固定为）：
 *   1) journal 已在 load() 阶段完成"末行半写截断"（store.journal.truncate/warn）
 *   2) index 缺失/损坏 → 从 players/* 重建；players 也损坏 → 全量重放 journal；二者皆空 → 全新库
 *   3) 逐档案校验 appliedSeq：落后 → 从 journal 补放；超过 journal 水位（不可能，除非篡改）→ 拒绝启动
 *   4) 重放 seq > 起点 的记录（幂等：每档案 appliedSeq / recent.battleId 双保险）
 *   5) 索引 seq 收敛到 journal 水位（journal 是 seq 的唯一权威来源）
 * 保证：任何崩溃点重启后不存在"只有一方记了账"的对局——对局成立 = journal 里那条记录已落盘。
 */
const { StoreError } = require('./errors.js');

const REPLAY_CHUNK = 64;

// 档案读取错误分类：版本不支持（§5.7）与锁冲突必须**拒绝启动**，不能当"损坏"隔离重建
// （把高版本档案当损坏隔离会静默丢弃新版本数据，违反"防止新版本写过的数据被旧版本覆盖"）
function isFatalArchiveError(err) {
  return !!err && err.name === 'StoreError' && (err.code === 'store_version_unsupported' || err.code === 'store_locked');
}

// host 契约（由 adapter-json.js 提供）：
//   journal / index / logger / config
//   indexLoaded:boolean                 —— 索引文件是否成功装载
//   listPlayerIds()                     —— 扫描 players/*
//   readArchiveRaw(playerId)            —— 读取档案（解析/校验失败抛 store_corrupt）
//   quarantineArchive(playerId, err)    —— 隔离损坏档案（改名保留）
//   applyRecords(records)               —— 幂等批量 apply（内部维护索引与水位）
//   saveIndex()                         —— 原子落盘索引
//   rebuildIndexFromArchives(archives)  —— 用档案集合重建索引
//   rebuildDerivedState()               —— 按 journal 重建派生内存状态（快照引用计数 + 墓碑水位）
async function recoverStore(host) {
  const { journal, index, logger } = host;
  const report = {
    journalSeq: 0,
    startSeq: 0,
    replayed: 0,
    rebuiltIndex: false,
    quarantined: [],
    scanned: 0,
    truncatedSegments: 0,
  };
  report.journalSeq = journal.maxSeq();
  report.replayed = 0;

  // ---- 步骤 2/5：索引基线 ----
  let baseSeq = 0;
  let playerIds = [];
  if (host.indexLoaded) {
    baseSeq = index.seq();
    playerIds = index.playerIds();
  } else {
    playerIds = await host.listPlayerIds();
    const archives = [];
    for (const playerId of playerIds) {
      report.scanned += 1;
      try {
        const archive = await host.readArchiveRaw(playerId);
        if (archive) archives.push(archive);
      } catch (err) {
        if (isFatalArchiveError(err)) throw err;
        report.quarantined.push(playerId);
        await host.quarantineArchive(playerId, err);
      }
    }
    if (archives.length > 0) {
      host.rebuildIndexFromArchives(archives);
      report.rebuiltIndex = true;
      baseSeq = archives.reduce((min, a) => Math.min(min, a.record.appliedSeq), Number.MAX_SAFE_INTEGER);
    } else if (playerIds.length > 0 && report.journalSeq === 0) {
      throw new StoreError('store_corrupt',
        `索引与 ${playerIds.length} 个档案均损坏，且 journal 为空：无法重建，请从备份恢复 runtime/`,
        [{ path: 'index.json', code: 'store_corrupt', message: '无可用的真源' }], { fatal: true });
    } else {
      baseSeq = 0; // 全量重放 journal
      report.rebuiltIndex = true;
      logger.info('store', 'store.recover', '索引缺失/损坏 → 从 journal 全量重建', { journalSeq: report.journalSeq });
    }
  }

  // ---- 步骤 3：逐档案校验 appliedSeq（落后 → 拉低重放起点；超前 → 拒绝启动）----
  let minApplied = baseSeq;
  for (const playerId of playerIds) {
    let archive = null;
    try {
      archive = await host.readArchiveRaw(playerId);
    } catch (err) {
      if (isFatalArchiveError(err)) throw err;
      report.quarantined.push(playerId);
      await host.quarantineArchive(playerId, err);
      archive = null;
    }
    if (!archive) {
      minApplied = 0; // 档案不可用 → 从 journal 重建
      continue;
    }
    const applied = archive.record.appliedSeq;
    if (applied > report.journalSeq) {
      throw new StoreError('store_corrupt',
        `档案 ${playerId} 的 appliedSeq=${applied} 超过 journal 水位 ${report.journalSeq}（疑似人为篡改），拒绝启动`,
        [{ path: playerId, code: 'store_corrupt', message: `appliedSeq ${applied} > journal ${report.journalSeq}` }],
        { fatal: true });
    }
    if (applied < minApplied) minApplied = applied;
  }

  // ---- 步骤 4：重放（幂等）----
  const startSeq = Number.isFinite(minApplied) ? minApplied : 0;
  report.startSeq = startSeq;
  if (startSeq < report.journalSeq) {
    let chunk = [];
    const flushChunk = async () => {
      if (chunk.length === 0) return;
      const res = await host.applyRecords(chunk);
      // replayed = **实际产生变更**的记录数（幂等跳过不计），干净重启即为 0（§6.4 步骤 4）
      report.replayed += res && Number.isInteger(res.recordsApplied) ? res.recordsApplied : chunk.length;
      chunk = [];
    };
    await journal.replay({ fromSeq: startSeq }, async (record) => {
      chunk.push(record);
      if (chunk.length >= REPLAY_CHUNK) await flushChunk();
    });
    await flushChunk();
  }

  // ---- 步骤 5：水位收敛 + 派生内存状态（快照引用计数 / 墓碑水位） ----
  index.setSeq(report.journalSeq);
  await host.saveIndex();
  host.rebuildDerivedState();
  logger.info('store', 'store.recover',
    `恢复完成：journal seq=${report.journalSeq}，重放 ${report.replayed} 条，起点 seq=${startSeq}`
    + (report.quarantined.length > 0 ? `，隔离损坏档案 ${report.quarantined.length} 个` : ''),
    {
      journalSeq: report.journalSeq, replayed: report.replayed, startSeq,
      rebuiltIndex: report.rebuiltIndex, quarantined: report.quarantined.length, scanned: report.scanned,
    });
  return report;
}

module.exports = { REPLAY_CHUNK, isFatalArchiveError, recoverStore };
