'use strict';
/* cli/index.js —— 命令行"操作台"（P0-8，契约 docs/interfaces.md §3）
 * 只走 HTTP（不 require server/core，L14）；退出码 0 成功 / 1 业务拒绝 / 2 参数错误（T-CLI-2）
 *   **P7-4 新增 3 = 未鉴权**（缺 token / 服务端 401，§10.4）。
 * P0-8 子命令：health / data / log；B16：ai validate|compile|battle；B17：box；B18：wh list|assemble|disassemble。
 * P7-4 子命令：auth register|login|logout|change-password；me；quick run；leaderboard；ranked promote。
 * token 来源（§10.4）：`--token <t>` > `options.token`（进程内调用）> 环境变量 `DL_TOKEN`。
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
  box [--tier <t>] [--times <k>]               # 开箱（B17；D-162 起不接受 --seed：seed 由服务端生成）
  wh list --file wh.json                       # 本地仓库摘要（分桶 + 装配状态）
  wh assemble|disassemble --file wh.json --item <uid> --slot <i> [--plugin <uid>] [--tier <t>]
                                               # 装配/拆卸（B18，经 HTTP）
  panel --loadout <file> [--tier <t>]          # 最终面板（B19，经 HTTP）
  battle --p1 a.json --p2 b.json [--seed <n>] [--tier <t>] [--out replay.json]
                                               # 双方 loadout 对战 → 完整回放帧（B22，经 HTTP）
  replay --file replay.json [--tick N]         # 文本回放（px 位置/碰撞/伤害值+暴击/背击标注；B23，本地文件）
  ranked run --seed <n> [--tier <t>] [--loadout <file>] [--pool <file>]
                                               # 排位 10 场离线结算（B24，经 HTTP；D-123 不持久化）
  auth <register|login|logout|change-password>  # 账号（P7-4，经 HTTP）
       auth register --user <u> --pass <p> [--nick <n>] [--save-token <file>]
       auth login    --user <u> --pass <p> [--save-token <file>]
       auth logout   [--token <t>]
       auth change-password --old <p> --new <p> [--token <t>]
  me [--token <t>]                             # 档案摘要（段位/积分/未读/槽位；P7-4）
  quick run [--seed <n>] [--token <t>]         # 快速对战（积分相近 + 非对称 Elo；P7-4）
  leaderboard [--limit <n>] [--scope <global|tier:<t>>]   # 排行榜（P7-4）
  ranked promote [--wins <n>] [--tier <t>] [--token <t>]
                                               # 晋升判定（登录时读档案；未登录为遗留口径需 --tier）
  token: --token <t> 或环境变量 DL_TOKEN（CLI 不落盘明文，--save-token 写文件时权限 0600）
exit codes: 0 成功 / 1 业务拒绝 / 2 参数错误 / 3 未鉴权`;

function httpJson(baseUrl, method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + urlPath);
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`;
    const req = http.request({
      hostname: u.hostname, port: u.port, method,
      path: u.pathname + u.search,
      headers,
    }, (res) => {
      // 跨 chunk 多字节字符（中文）必须按 Buffer 累积后**整段**解码：
      //   `d += c` 会对每个 TCP chunk 各自 toString('utf8')，字符跨 chunk 边界时被解成 U+FFFD
      //   （与 server/index.js 的 readBody、tests/helpers/http.js 同源修复）。
      const chunks = [];
      res.on('data', (c) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); });
      res.on('end', () => {
        const d = Buffer.concat(chunks).toString('utf8');
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

/* ---------- P7-4：退出码、旗标与 token（§10.4） ---------- */

const EXIT_UNAUTHORIZED = 3;

// 结果 → stdout/stderr + 退出码：200 → 0；401（未鉴权）→ 3；其余非 200 → 1
function finish(r) {
  if (r.status === 200) {
    console.log(JSON.stringify(r.body ? r.body.data : null, null, 2));
    return 0;
  }
  console.error(JSON.stringify((r.body && r.body.error) || { code: 'unknown', message: r.raw }));
  return r.status === 401 ? EXIT_UNAUTHORIZED : 1;
}

function usageError(message) {
  console.error(`${message}\n${USAGE}`);
  return 2;
}

// 解析 `--key value` 序列；未登记旗标或缺少取值 → { valid:false }
function parseFlags(args, spec) {
  const flags = {};
  let valid = true;
  for (let i = 0; i < (args || []).length; i++) {
    const a = args[i];
    const name = typeof a === 'string' && a.startsWith('--') ? a.slice(2) : null;
    if (name === null || !spec.includes(name)) { valid = false; break; }
    const value = args[++i];
    if (value === undefined) { valid = false; break; }
    flags[name] = value;
  }
  return { valid, flags };
}

function tokenOf(flags, opts) {
  if (flags && flags.token) return flags.token;
  if (opts && opts.token) return opts.token;
  return process.env.DL_TOKEN || null;
}

function unauthorized() {
  console.error('未鉴权：缺少会话 token（--token <t> 或环境变量 DL_TOKEN）');
  return EXIT_UNAUTHORIZED;
}

// seed 形参 → 正整数（非法值原样透传 → 服务端 400 bad_seed）
function toSeed(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : value;
}

const AUTH_PATHS = Object.freeze({
  register: '/api/v1/auth/register',
  login: '/api/v1/auth/login',
  logout: '/api/v1/auth/logout',
  'change-password': '/api/v1/auth/change-password',
});

function authBodyOf(sub, flags) {
  if (sub === 'register') return { username: flags.user, password: flags.pass, nickname: flags.nick };
  if (sub === 'login') return { username: flags.user, password: flags.pass };
  if (sub === 'change-password') return { oldPassword: flags.old, newPassword: flags.new };
  return {};
}

// auth register|login|logout|change-password（P7-4）
async function cmdAuth(baseUrl, args, opts) {
  const sub = args[1];
  if (!Object.prototype.hasOwnProperty.call(AUTH_PATHS, sub)) {
    return usageError('auth 需要一个子命令（register/login/logout/change-password）');
  }
  const spec = sub === 'register' ? ['user', 'pass', 'nick', 'save-token']
    : sub === 'login' ? ['user', 'pass', 'save-token']
      : sub === 'change-password' ? ['old', 'new', 'token'] : ['token'];
  const parsed = parseFlags(args.slice(2), spec);
  if (!parsed.valid) return usageError(`auth ${sub} 参数非法`);
  const flags = parsed.flags;
  if ((sub === 'register' || sub === 'login') && (!flags.user || !flags.pass)) {
    return usageError(`auth ${sub} 需要 --user 与 --pass`);
  }
  if (sub === 'change-password' && (!flags.old || !flags.new)) {
    return usageError('auth change-password 需要 --old 与 --new');
  }
  const token = tokenOf(flags, opts);
  if ((sub === 'logout' || sub === 'change-password') && !token) return unauthorized();
  const r = await httpJson(baseUrl, 'POST', AUTH_PATHS[sub], authBodyOf(sub, flags), token);
  if (r.status === 200 && flags['save-token']) {
    try {
      fs.writeFileSync(flags['save-token'], r.body.data.token, { mode: 0o600 });
    } catch (e) {
      console.error(`写入 ${flags['save-token']} 失败: ${e.message}`);
      return 1;
    }
    console.log(JSON.stringify({ savedToken: flags['save-token'], publicId: r.body.data.publicId, nickname: r.body.data.nickname }, null, 2));
    return 0;
  }
  return finish(r);
}

// me（P7-4）
async function cmdMe(baseUrl, args, opts) {
  const parsed = parseFlags(args.slice(1), ['token']);
  if (!parsed.valid) return usageError('me 参数非法');
  const token = tokenOf(parsed.flags, opts);
  if (!token) return unauthorized();
  return finish(await httpJson(baseUrl, 'GET', '/api/v1/me', undefined, token));
}

// quick run（P7-4）
async function cmdQuickRun(baseUrl, args, opts) {
  if (args[1] !== 'run') return usageError('quick 需要一个子命令（run）');
  const parsed = parseFlags(args.slice(2), ['token', 'seed']);
  if (!parsed.valid) return usageError('quick run 参数非法');
  const token = tokenOf(parsed.flags, opts);
  if (!token) return unauthorized();
  const body = {};
  if (parsed.flags.seed !== undefined) body.seed = toSeed(parsed.flags.seed);
  return finish(await httpJson(baseUrl, 'POST', '/api/v1/quick/run', body, token));
}

// leaderboard（P7-4；无需鉴权）
async function cmdLeaderboard(baseUrl, args, opts) {
  const parsed = parseFlags(args.slice(1), ['limit', 'scope', 'token']);
  if (!parsed.valid) return usageError('leaderboard 参数非法');
  const q = [];
  if (parsed.flags.limit !== undefined) q.push(`limit=${encodeURIComponent(parsed.flags.limit)}`);
  if (parsed.flags.scope !== undefined) q.push(`scope=${encodeURIComponent(parsed.flags.scope)}`);
  const path = `/api/v1/leaderboard${q.length > 0 ? `?${q.join('&')}` : ''}`;
  return finish(await httpJson(baseUrl, 'GET', path, undefined, tokenOf(parsed.flags, opts)));
}

// ranked promote（P7-4：已登录 → 段位读档案；未登录 → 遗留 --tier 口径）
async function cmdRankedPromote(baseUrl, args, opts) {
  const parsed = parseFlags(args.slice(2), ['token', 'tier', 'wins']);
  if (!parsed.valid) return usageError('ranked promote 参数非法');
  const body = {};
  if (parsed.flags.tier !== undefined) body.tier = parsed.flags.tier;
  if (parsed.flags.wins !== undefined) {
    const n = Number(parsed.flags.wins);
    body.wins = Number.isInteger(n) && n >= 0 ? n : parsed.flags.wins; // 非法 → 服务端 400 bad_wins
  }
  const token = tokenOf(parsed.flags, opts);
  if (token) return finish(await httpJson(baseUrl, 'POST', '/api/v1/ranked/promote', body, token));
  if (body.tier === undefined) return usageError('ranked promote 未登录时需要 --tier（遗留无状态口径）');
  return finish(await httpJson(baseUrl, 'POST', '/api/v1/ranked/promote', body));
}


/* ---- replay 伤害标注（B23 可读性增强；用户 2026-09-19 勾选项 2）
 * 素材来源（D-167 起）：帧 `diff.damages[]` 的 `{attacker,target,amount,atX,kind,srcUid,crit,critM,backstab,backM}`
 *   ——**不再读 `diff.events`**（日志已从对外帧剥离，见 interfaces.md §4.3 与 D-167）。
 * 关联规则：`srcUid` 与帧 `bulletHits[].uid` 一一对应；`srcUid === null`（碰撞/撞基地/超时）单独归入「伤害[]」段。
 * 只读帧数据，不 require core/ai（L14：CLI 只走 HTTP/本地文件）。
 */
function damageByHit(damages) {
  const map = new Map();
  for (const dm of damages || []) {
    if (dm && typeof dm.srcUid === 'string' && dm.srcUid !== '') map.set(dm.srcUid, dm);
  }
  return map;
}

// 伤害标注：`9` / `9 (暴击×1.5)` / `9 (暴击×1.5 背击×1.5)`
function damageTag(dm) {
  const marks = [];
  if (dm.crit) marks.push(`暴击×${dm.critM}`);
  if (dm.backstab) marks.push(`背击×${dm.backM}`);
  return `${dm.amount}${marks.length > 0 ? ` (${marks.join(' ')})` : ''}`;
}

// 逐 tick 文本行：px 位置/碰撞 + 命中（uid->目标@坐标->伤害）+ 无弹幕归属的伤害（碰撞/撞基地/超时）
function replayLine(f) {
  const d = f.diff;
  const p = (o) => `${o} ${d.players[o].fromX}->${d.players[o].toX} hp=${d.players[o].hp} mp=${d.players[o].mp} sp=${d.players[o].sp}`;
  const coll = d.collision ? ` | 碰撞@${d.collision.contactX}` : '';
  const damages = Array.isArray(d.damages) ? d.damages : [];
  const dmgByUid = damageByHit(damages);
  const hits = d.bulletHits && d.bulletHits.length
    ? ` | 命中[${d.bulletHits.map((h) => {
      const base = `${h.uid}->${h.target}@${h.atX}`;
      const dm = dmgByUid.get(h.uid);
      return dm ? `${base}->${dm.attacker}->${dm.target} ${damageTag(dm)}` : base;
    }).join(' ')}]`
    : '';
  const loose = damages.filter((dm) => dm && (dm.srcUid === null || dm.srcUid === undefined));
  const extra = loose.length ? ` | 伤害[${loose.map((dm) => `${dm.attacker === null ? dm.kind : dm.attacker}->${dm.target} ${damageTag(dm)}`).join(' ')}]` : '';
  return `tick ${f.tick}: ${p('p1')} | ${p('p2')}${coll}${hits}${extra}`;
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
      // box [--tier <t>] [--times <k>]
      // D-162：`seed` **不是接口参数**（随机性由服务端独占）→ 本命令不再接受 `--seed`（给了即参数错误，exit 2）
      let tier = null;
      let times = null;
      let valid = true;
      for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a === '--tier') tier = args[++i];
        else if (a === '--times') times = args[++i];
        else { valid = false; }
      }
      if (!valid) {
        console.error(`box 参数非法（本命令不接受 --seed：D-162 起 seed 由服务端生成）\n${USAGE}`);
        code = 2;
      } else {
        const body = {};
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
              if (tickArg !== null) {
                const n = Number(tickArg);
                const frame = Number.isInteger(n) && n >= 1 ? frames.find((f) => f.tick === n) : null;
                if (!frame || !frameOk(frame)) {
                  console.error(`tick ${tickArg} 不存在或内容非法（回放范围 1..${frames.length}）`);
                  code = 2;
                } else {
                  const d = frame.diff;
                  console.log(replayLine(frame));
                  if (d.verdict) console.log(`verdict: winner=${d.verdict.winner} phase=${d.verdict.phase}`);
                  // D-167：对外帧不再携带引擎日志（events）；此处改为回显该 tick 的结构化伤害与弹幕结局
                  const dmg = Array.isArray(d.damages) ? d.damages : [];
                  console.log(`damages (${dmg.length}):`);
                  for (const dm of dmg) console.log(`  ${dm.kind} ${dm.attacker === null ? '-' : dm.attacker}->${dm.target} ${damageTag(dm)}${dm.atX === null ? '' : '@' + dm.atX}`);
                  if (Array.isArray(d.bullets) && d.bullets.length) {
                    console.log(`bullets (${d.bullets.length}):`);
                    for (const b of d.bullets) console.log(`  ${b.uid} ${b.spawnX}->${b.endX} outcome=${b.outcome}${b.hitTarget ? ' ->' + b.hitTarget : ''}${b.collideWith ? ' vs ' + b.collideWith : ''}`);
                  }
                  code = 0;
                }
              } else {
                for (const f of frames) {
                  if (frameOk(f)) console.log(replayLine(f));
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
    } else if (cmd === 'auth') {
      code = await cmdAuth(baseUrl, args, opts);
    } else if (cmd === 'me') {
      code = await cmdMe(baseUrl, args, opts);
    } else if (cmd === 'quick') {
      code = await cmdQuickRun(baseUrl, args, opts);
    } else if (cmd === 'leaderboard') {
      code = await cmdLeaderboard(baseUrl, args, opts);
    } else if (cmd === 'ranked') {
      // ranked run --seed <n> [--tier <t>] [--loadout <file>] [--pool <file>]（B24）
      // ranked promote [--wins n] [--tier t] [--token t]（P7-4）
      const sub = args[1];
      if (sub === 'promote') {
        code = await cmdRankedPromote(baseUrl, args, opts);
      } else if (sub !== 'run') {
        console.error(`ranked 需要一个子命令（run/promote）\n${USAGE}`);
        code = 2;
      } else {
        let seed = null;
        let tier = null;
        let ldf = null;
        let poolf = null;
        let valid = true;
        for (let i = 2; i < args.length; i++) {
          const a = args[i];
          if (a === '--seed') seed = args[++i];
          else if (a === '--tier') tier = args[++i];
          else if (a === '--loadout') ldf = args[++i];
          else if (a === '--pool') poolf = args[++i];
          else { valid = false; }
        }
        if (!valid || !ldf) {
          console.error(`ranked run 参数非法（--loadout 必填）\n${USAGE}`);
          code = 2;
        } else {
          const readJson = (f, what) => {
            try {
              return { data: JSON.parse(fs.readFileSync(f, 'utf8')), err: null };
            } catch (e) {
              return { data: null, err: `读取/解析 ${f} 失败: ${e.message}` };
            }
          };
          const lr = readJson(ldf);
          let failed = false;
          if (lr.err) {
            console.error(lr.err);
            code = 2;
            failed = true;
          } else {
            const raw = lr.data;
            const body = { loadout: raw && typeof raw === 'object' && raw.loadout ? raw.loadout : raw };
            if (raw && raw.warehouse) body.warehouse = raw.warehouse;
            if (seed !== null) {
              const n = Number(seed);
              body.seed = Number.isInteger(n) && n >= 1 ? n : seed;
            }
            if (tier !== null) body.tier = tier;
            if (poolf !== null) {
              const pr = readJson(poolf, 'pool');
              if (pr.err) {
                console.error(pr.err);
                code = 2;
                failed = true;
              } else if (!Array.isArray(pr.data)) {
                console.error('--pool 文件必须是 loadout 数组');
                code = 2;
                failed = true;
              } else {
                body.pool = pr.data;
              }
            }
            if (!failed) {
              const r = await httpJson(baseUrl, 'POST', '/api/v1/ranked/run', body);
              if (r.status === 200) {
                console.log(JSON.stringify({
                  tier: r.body.data.tier, seed: r.body.data.seed, matches: r.body.data.matches,
                  wins: r.body.data.wins, draws: r.body.data.draws, losses: r.body.data.losses,
                  promoted: r.body.data.promoted,
                }, null, 2));
                code = 0;
              } else {
                console.error(JSON.stringify((r.body && r.body.error) || { code: 'unknown', message: r.raw }));
                code = 1;
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

// replayLine 额外导出：scripts/play.js（离线试玩）复用同一战报行格式，避免两套渲染漂移。
module.exports = { main, bootstrap, USAGE, httpJson, replayLine };

if (require.main === module) {
  bootstrap();
}