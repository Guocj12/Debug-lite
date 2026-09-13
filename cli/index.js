'use strict';
/* cli/index.js —— 命令行"操作台"（P0-8，契约 docs/interfaces.md §3）
 * 只走 HTTP（不 require server/core，L14）；退出码 0 成功 / 1 业务拒绝 / 2 参数错误（T-CLI-2）。
 * P0-8 子命令：health / data / log；B16：ai validate|compile|battle；B17：box；B18：wh list|assemble|disassemble。
 */
const http = require('node:http');
const fs = require('node:fs');
const { createLogger, parseLevel } = require('../shared/log.js');

const USAGE = `usage: node cli/index.js <command> [args]
commands:
  health                          # 服务存活与版本
  data <table>                    # 数据表内容（如 battle-config）
  log [--level <l>] [--channel ch=lv]  # 日志总控（GET/POST /api/v1/log-level）
  ai <validate|compile|battle> --file ai.json [--tier <t>] [--opponent <o>] [--seed <n>]
                                  # AI 程序校验/编译/对战（B16）
  box [--seed <n>] [--tier <t>] [--times <k>]  # 开箱（B17）
  wh list --file wh.json                       # 本地仓库摘要（分桶 + 装配状态）
  wh assemble|disassemble --file wh.json --item <uid> --slot <i> [--plugin <uid>] [--tier <t>]
                                               # 装配/拆卸（B18，经 HTTP）
  panel --loadout <file> [--tier <t>]          # 最终面板（B19，经 HTTP）
  battle --p1 a.json --p2 b.json [--seed <n>] [--tier <t>] [--out replay.json]
                                               # 双方 loadout 对战 → 完整回放帧（B22，经 HTTP）
  replay --file replay.json [--tick N]         # 文本回放（px 位置/碰撞/事件；B23，本地文件）
exit codes: 0 成功 / 1 业务拒绝 / 2 参数错误`;

function httpJson(baseUrl, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + urlPath);
    const req = http.request({
      hostname: u.hostname, port: u.port, method,
      path: u.pathname + u.search,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch (e) { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, body: json, raw: d });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main(argv, options) {
  const opts = options || {};
  const baseUrl = opts.baseUrl || `http://127.0.0.1:${process.env.DL_PORT || 3000}`;
  const logger = opts.logger || createLogger();
  const args = argv || [];
  const started = Date.now();
  logger.info('cli', 'cli.invoke', `argv=${args.join(' ')}`, { argv: args });
  let code = 2;
  try {
    const cmd = args[0];
    if (cmd === 'health') {
      const r = await httpJson(baseUrl, 'GET', '/api/v1/health');
      if (r.status === 200) {
        console.log(JSON.stringify(r.body, null, 2));
        code = 0;
      } else {
        console.error(JSON.stringify((r.body && r.body.error) || { code: 'unknown', message: r.raw }));
        code = 1;
      }
    } else if (cmd === 'data') {
      if (!args[1]) {
        console.error(`data 需要一个表名（battle-config/role-templates/skill-templates/plugins/qualities/items-config/unlock/sprites/animations）\n`);
        code = 2;
      } else {
        const r = await httpJson(baseUrl, 'GET', `/api/v1/data/${encodeURIComponent(args[1])}`);
        if (r.status === 200) {
          console.log(JSON.stringify(r.body.data, null, 2));
          code = 0;
        } else {
          console.error(JSON.stringify((r.body && r.body.error) || { code: 'unknown', message: r.raw }));
          code = 1;
        }
      }
    } else if (cmd === 'log') {
      let level;
      const channels = {};
      let valid = true;
      for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a === '--level') {
          level = args[++i];
          if (!level) { valid = false; }
        } else if (a === '--channel') {
          const kv = args[++i] || '';
          const eq = kv.indexOf('=');
          if (eq <= 0 || parseLevel(kv.slice(eq + 1)) === null) { valid = false; } else { channels[kv.slice(0, eq)] = kv.slice(eq + 1); }
        } else {
          valid = false;
        }
      }
      if (!valid) {
        console.error(`log 参数非法\n${USAGE}`);
        code = 2;
      } else if (level !== undefined && parseLevel(String(level)) === null) {
        console.error(`非法级别 ${level}（可选: silent/fatal/error/warn/info/debug/trace/all）`);
        code = 2;
      } else {
        const body = {};
        if (level !== undefined) body.level = level;
        if (Object.keys(channels).length) body.channels = channels;
        const r = await httpJson(baseUrl, 'POST', '/api/v1/log-level', body);
        if (r.status === 200) {
          console.log(JSON.stringify(r.body.data, null, 2));
          code = 0;
        } else {
          console.error(JSON.stringify((r.body && r.body.error) || { code: 'unknown', message: r.raw }));
          code = 1;
        }
      }
    } else if (cmd === 'ai') {
      // ai validate|compile|battle --file ai.json [--tier t] [--opponent o] [--seed n]
      const sub = args[1];
      if (!['validate', 'compile', 'battle'].includes(sub)) {
        console.error(`ai 需要一个子命令（validate/compile/battle）\n${USAGE}`);
        code = 2;
      } else {
        let file = null;
        let tier = null;
        let opponent = null;
        let seed = null;
        let valid = true;
        for (let i = 2; i < args.length; i++) {
          const a = args[i];
          if (a === '--file') file = args[++i];
          else if (a === '--tier') tier = args[++i];
          else if (a === '--opponent') opponent = args[++i];
          else if (a === '--seed') seed = args[++i];
          else { valid = false; }
        }
        if (!valid || !file) {
          console.error(`ai ${sub} 参数非法（--file 必填）\n${USAGE}`);
          code = 2;
        } else {
          let program = null;
          try {
            program = JSON.parse(fs.readFileSync(file, 'utf8'));
          } catch (e) {
            console.error(`读取/解析 ${file} 失败: ${e.message}`);
            code = 2;
          }
          if (program !== null) {
            const body = { program };
            if (tier !== null) body.tier = tier;
            if (opponent !== null) body.opponent = opponent;
            if (seed !== null) {
              const n = Number(seed);
              body.seed = Number.isInteger(n) && n >= 1 ? n : seed; // 非法 → 服务端 400 bad_seed
            }
            const r = await httpJson(baseUrl, 'POST', `/api/v1/ai/${sub}`, body);
            if (r.status === 200) {
              console.log(JSON.stringify(r.body.data, null, 2));
              code = 0;
            } else {
              console.error(JSON.stringify((r.body && r.body.error) || { code: 'unknown', message: r.raw }));
              code = 1;
            }
          }
        }
      }
    } else if (cmd === 'box') {
      // box [--seed <n>] [--tier <t>] [--times <k>]
      let seed = null;
      let tier = null;
      let times = null;
      let valid = true;
      for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a === '--seed') seed = args[++i];
        else if (a === '--tier') tier = args[++i];
        else if (a === '--times') times = args[++i];
        else { valid = false; }
      }
      if (!valid) {
        console.error(`box 参数非法\n${USAGE}`);
        code = 2;
      } else {
        const body = {};
        if (seed !== null) {
          const n = Number(seed);
          body.seed = Number.isInteger(n) && n >= 1 ? n : seed; // 非法 → 服务端 400 bad_seed
        }
        if (tier !== null) body.tier = tier;
        if (times !== null) {
          const k = Number(times);
          body.times = Number.isInteger(k) && k >= 1 ? k : times; // 非法 → 服务端 400 bad_times
        }
        const r = await httpJson(baseUrl, 'POST', '/api/v1/box', body);
        if (r.status === 200) {
          console.log(JSON.stringify(r.body.data, null, 2));
          code = 0;
        } else {
          console.error(JSON.stringify((r.body && r.body.error) || { code: 'unknown', message: r.raw }));
          code = 1;
        }
      }
    } else if (cmd === 'wh') {
      // wh list --file wh.json | wh assemble|disassemble --file wh.json --item <uid> --slot <i> [--plugin <uid>] [--tier <t>]
      const sub = args[1];
      if (!['list', 'assemble', 'disassemble'].includes(sub)) {
        console.error(`wh 需要一个子命令（list/assemble/disassemble）\n${USAGE}`);
        code = 2;
      } else {
        let file = null;
        let item = null;
        let slot = null;
        let plugin = null;
        let tier = null;
        let valid = true;
        for (let i = 2; i < args.length; i++) {
          const a = args[i];
          if (a === '--file') file = args[++i];
          else if (a === '--item') item = args[++i];
          else if (a === '--slot') slot = args[++i];
          else if (a === '--plugin') plugin = args[++i];
          else if (a === '--tier') tier = args[++i];
          else { valid = false; }
        }
        if (!valid || !file) {
          console.error(`wh ${sub} 参数非法（--file 必填）\n${USAGE}`);
          code = 2;
        } else if (sub !== 'list' && (!item || slot === null || Number.isNaN(Number(slot)))) {
          console.error(`wh ${sub} 需要 --item <uid> 与 --slot <i>\n${USAGE}`);
          code = 2;
        } else if (sub === 'assemble' && !plugin) {
          console.error(`wh assemble 需要 --plugin <uid>\n${USAGE}`);
          code = 2;
        } else {
          let wh = null;
          try {
            wh = JSON.parse(fs.readFileSync(file, 'utf8'));
          } catch (e) {
            console.error(`读取/解析 ${file} 失败: ${e.message}`);
            code = 2;
          }
          if (wh !== null) {
            if (sub === 'list') {
              // 本地摘要（只读文件；不 require core）
              const buckets = (wh.buckets || {});
              const summary = {};
              for (const [kind, items] of Object.entries(buckets)) {
                summary[kind] = { total: (items || []).length, equipped: (items || []).filter((x) => x && x.equipped).length };
              }
              console.log(JSON.stringify(summary, null, 2));
              code = 0;
            } else {
              const body = { warehouse: wh, targetUid: item, slotIndex: Number(slot) };
              if (plugin !== null) body.pluginUid = plugin;
              if (tier !== null) body.tier = tier;
              const r = await httpJson(baseUrl, 'POST', `/api/v1/warehouse/${sub}`, body);
              if (r.status === 200) {
                console.log(JSON.stringify(r.body.data.warehouse, null, 2));
                code = 0;
              } else {
                console.error(JSON.stringify((r.body && r.body.error) || { code: 'unknown', message: r.raw }));
                code = 1;
              }
            }
          }
        }
      }
    } else if (cmd === 'panel') {
      // panel --loadout <file> [--tier <t>]；文件可为裸 loadout 或 {loadout, warehouse} 包装（B19）
      let file = null;
      let tier = null;
      let valid = true;
      for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a === '--loadout') file = args[++i];
        else if (a === '--tier') tier = args[++i];
        else { valid = false; }
      }
      if (!valid || !file) {
        console.error(`panel 参数非法（--loadout 必填）\n${USAGE}`);
        code = 2;
      } else {
        let raw = null;
        try {
          raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
          console.error(`读取/解析 ${file} 失败: ${e.message}`);
          code = 2;
        }
        if (raw !== null) {
          const loadout = raw && typeof raw === 'object' && raw.loadout ? raw.loadout : raw;
          const body = { loadout };
          if (raw && raw.warehouse) body.warehouse = raw.warehouse;
          if (tier !== null) body.tier = tier;
          const r = await httpJson(baseUrl, 'POST', '/api/v1/panel', body);
          if (r.status === 200) {
            console.log(JSON.stringify(r.body.data.panel, null, 2));
            code = 0;
          } else {
            console.error(JSON.stringify((r.body && r.body.error) || { code: 'unknown', message: r.raw }));
            code = 1;
          }
        }
      }
    } else if (cmd === 'battle') {
      // battle --p1 a.json --p2 b.json [--seed <n>] [--tier <t>] [--out replay.json]（B22）
      let p1 = null;
      let p2 = null;
      let seed = null;
      let tier = null;
      let out = null;
      let valid = true;
      for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a === '--p1') p1 = args[++i];
        else if (a === '--p2') p2 = args[++i];
        else if (a === '--seed') seed = args[++i];
        else if (a === '--tier') tier = args[++i];
        else if (a === '--out') out = args[++i];
        else { valid = false; }
      }
      if (!valid || !p1 || !p2) {
        console.error(`battle 参数非法（--p1/--p2 必填）\n${USAGE}`);
        code = 2;
      } else {
        const readLd = (f) => {
          try {
            const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
            return raw && typeof raw === 'object' && raw.loadout ? { ld: raw.loadout, wh: raw.warehouse || null } : { ld: raw, wh: null };
          } catch (e) {
            console.error(`读取/解析 ${f} 失败: ${e.message}`);
            return null;
          }
        };
        const r1 = readLd(p1);
        const r2 = readLd(p2);
        if (r1 === null || r2 === null) {
          code = 2;
        } else {
          const body = { p1: r1.ld, p2: r2.ld };
          if (r1.wh) body.warehouse = r1.wh;
          else if (r2.wh) body.warehouse = r2.wh;
          if (seed !== null) {
            const n = Number(seed);
            body.seed = Number.isInteger(n) && n >= 1 ? n : seed;
          }
          if (tier !== null) body.tier = tier;
          const r = await httpJson(baseUrl, 'POST', '/api/v1/battle', body);
          if (r.status === 200) {
            const data = r.body.data;
            const summary = { seed: data.seed, winner: data.winner, phase: data.phase, ticks: data.ticks };
            if (out !== null) {
              try {
                fs.writeFileSync(out, JSON.stringify({ summary, frames: data.frames }, null, 2));
              } catch (e) {
                console.error(`写入 ${out} 失败: ${e.message}`);
                code = 1;
              }
              if (code !== 1) {
                console.log(JSON.stringify({ summary, replayId: data.id, out }, null, 2));
                code = 0;
              }
            } else {
              console.log(JSON.stringify({ summary, replayId: data.id, frames: data.frames.length }, null, 2));
              code = 0;
            }
          } else {
            console.error(JSON.stringify((r.body && r.body.error) || { code: 'unknown', message: r.raw }));
            code = 1;
          }
        }
      }
    } else if (cmd === 'replay') {
      // replay --file replay.json [--tick N]（B23 文本回放：px 位置/碰撞/事件；本地文件，不碰服务端）
      let file = null;
      let tickArg = null;
      let valid = true;
      for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a === '--file') file = args[++i];
        else if (a === '--tick') tickArg = args[++i];
        else { valid = false; }
      }
      if (!valid || !file) {
        console.error(`replay 参数非法（--file 必填）\n${USAGE}`);
        code = 2;
      } else {
        let data = null;
        try {
          data = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
          console.error(`读取/解析 ${file} 失败: ${e.message}`);
          code = 2;
        }
        if (data !== null) {
          const frames = Array.isArray(data.frames) ? data.frames : null;
          if (!frames || frames.length === 0) {
            console.error(`回放文件无 frames（应来自 battle --out 或 GET /replay）`);
            code = 2;
          } else {
            // 帧内容护栏（B23 P1-1：畸形帧不得抛穿为「连接失败」）
            const frameOk = (f) => {
              const d = f && f.diff;
              return !!(d && d.players && d.players.p1 && d.players.p2
                && Number.isInteger(d.players.p1.fromX) && Number.isInteger(d.players.p1.toX)
                && Number.isInteger(d.players.p2.fromX) && Number.isInteger(d.players.p2.toX));
            };
            if (!frames.some(frameOk)) {
              console.error(`回放文件帧内容非法（缺 diff/players 或位置非 1px）`);
              code = 2;
            } else {
              const line = (f) => {
                const d = f.diff;
                const p = (o) => `${o} ${d.players[o].fromX}->${d.players[o].toX} hp=${d.players[o].hp} mp=${d.players[o].mp} sp=${d.players[o].sp}`;
                const coll = d.collision ? ` | 碰撞@${d.collision.contactX}` : '';
                const hits = d.bulletHits && d.bulletHits.length ? ` | 命中[${d.bulletHits.map((h) => `${h.uid}->${h.target}@${h.atX}`).join(' ')}]` : '';
                return `tick ${f.tick}: ${p('p1')} | ${p('p2')}${coll}${hits}`;
              };
              if (tickArg !== null) {
                const n = Number(tickArg);
                const frame = Number.isInteger(n) && n >= 1 ? frames.find((f) => f.tick === n) : null;
                if (!frame || !frameOk(frame)) {
                  console.error(`tick ${tickArg} 不存在或内容非法（回放范围 1..${frames.length}）`);
                  code = 2;
                } else {
                  const d = frame.diff;
                  console.log(line(frame));
                  if (d.verdict) console.log(`verdict: winner=${d.verdict.winner} phase=${d.verdict.phase}`);
                  const evs = Array.isArray(d.events) ? d.events : [];
                  console.log(`events (${evs.length}):`);
                  for (const e of evs.slice(-12)) console.log(`  [${e.cid}] ${e.channel}.${e.event} ${e.msg || ''}`);
                  code = 0;
                }
              } else {
                for (const f of frames) {
                  if (frameOk(f)) console.log(line(f));
                }
                const last = frames[frames.length - 1];
                const v = last && last.diff && last.diff.verdict;
                if (v) console.log(`verdict: winner=${v.winner} phase=${v.phase}（${frames.length} tick）`);
                code = 0;
              }
            }
          }
        }
      }
    } else {
      console.error(`未知命令: ${cmd}\n${USAGE}`);
      code = 2;
    }
  } catch (e) {
    console.error(`连接失败: ${e.message}（服务端未运行？）`);
    code = 1;
  }
  logger.info('cli', 'cli.result', `code=${code}`, { code, durationMs: Date.now() - started });
  return code;
}

// standalone 引导：导出以便测试执行（函数/分支覆盖要求，P0-8 审查 P2）；cli 进程入口即 node cli/index.js
async function bootstrap(options) {
  try {
    process.exitCode = await main(process.argv.slice(2), options);
  } catch (e) {
    console.error(e);
    process.exitCode = 2;
  }
}

module.exports = { main, bootstrap, USAGE, httpJson };

if (require.main === module) {
  bootstrap();
}