'use strict';
/* tools/layout/lab-server.js —— 布局工具的本地服务（零依赖，只监听 127.0.0.1）
 *
 * 为什么需要它：浏览器页面不能直接往工作区写文件。有了这个小服务，布局台就能：
 *   · 「存到工作区」→ 把导出 JSON 写进 runtime/layout-bundle.raw.json（**工作区的真实文件**）
 *     并顺手跑 import-layout.js → 生成 public/layout-data.js（AI 拿到就能替换前端）
 *   · 「素材清单」→ 跑 asset-manifest.js，列出**所有缺失的 UI 图片及名字**
 *   · 「归位素材」→ 跑 apply-assets.js，把 assets-inbox/ 里的图改名/转格式/缩放后放进 public/assets/
 *   · 「一键应用」= 上面三件一起做
 *
 * 启动：node tools/layout/lab-server.js [--port 4319]
 *   然后浏览器打开 http://127.0.0.1:4319/
 *   （直接双击 lab.html 也能用，只是没有"存到工作区 / 素材清单"这些按钮——它们需要本地服务）
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const LAB = path.join(__dirname, 'lab.html');
const RAW = path.join(__dirname, 'layout-bundle.raw.json');
const HISTORY_DIR = path.join(__dirname, 'exports');
const MANIFEST_JSON = path.join(__dirname, 'assets-manifest.json');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2',
};

/** 这个请求是浏览器"打开页面"（而不是 fetch/脚本）？用于决定 404 该回 HTML 还是 JSON */
function wantsHtml(req) {
  const accept = String(req.headers.accept || '');
  return accept.indexOf('text/html') >= 0;
}

function send(res, status, type, body) {
  // 本地开发服务：允许从别的本地页面（file:// 或 GUI 预览 iframe）调用，只监听 127.0.0.1
  res.writeHead(status, {
    'content-type': type, 'cache-control': 'no-store',
    'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}
// **所有**响应都是 JSON：页面统一 r.json()，回纯文本会让它抛 "Unexpected token" （实际发生过的缺陷）
function sendJson(res, obj, status) {
  const code = status !== undefined ? status : (obj.ok === false ? 400 : 200);
  send(res, code, MIME['.json'], JSON.stringify(obj, null, 1));
}

function runNode(script, args, timeout) {
  const r = spawnSync(process.execPath, [path.join(__dirname, script)].concat(args || []), {
    cwd: ROOT, encoding: 'utf8', timeout: timeout || 120000,
  });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 8 * 1024 * 1024) { reject(new Error('请求体过大（>8MB）')); req.destroy(); } });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

/** 静态文件（限定在两个根目录内，防目录穿越） */
function serveFile(res, absPath) {
  const roots = [__dirname, path.join(ROOT, 'public')];
  const ok = roots.some((r) => absPath === r || absPath.startsWith(r + path.sep));
  if (!ok || !fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    return sendJson(res, { ok: false, error: 'not_found', path: absPath, hint: '静态资源不存在（只服务 tools/layout/ 与 public/）' }, 404);
  }
  void 0;   // 静态缺失一律 JSON（调用方是页面脚本；浏览器导航的那条在路由兜底里回首页）
  const ext = path.extname(absPath).toLowerCase();
  return send(res, 200, MIME[ext] || 'application/octet-stream', fs.readFileSync(absPath));
}

function saveLayout(body) {
  const text = String(body || '').trim();
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { return { ok: false, error: 'JSON 解析失败：' + e.message }; }
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(HISTORY_DIR, 'layout-' + stamp + '.json'), text + '\n');
  fs.writeFileSync(RAW, text + '\n');
  const imp = runNode('import-layout.js');
  return {
    ok: imp.code === 0,
    raw: RAW,
    history: path.join(HISTORY_DIR, 'layout-' + stamp + '.json'),
    data: path.join(ROOT, 'public', 'layout-data.js'),
    importLog: (imp.out + imp.err).trim().split('\n').slice(-12),
    nextStep: 'AI 侧：node tools/layout/import-layout.js 已自动跑过，public/layout-data.js 已更新',
  };
}

function manifestSummary(full) {
  const m = JSON.parse(fs.readFileSync(MANIFEST_JSON, 'utf8'));
  const missing = m.entries.filter((e) => e.status === '缺' && !e.optional);
  return {
    summary: m.summary,
    missing: (full ? missing : missing.filter((e) => e.priority === 'core')).map((e) => ({
      file: path.basename(e.path), path: e.path, label: e.label, priority: e.priority, kind: e.kind,
    })),
    missingTotal: missing.length,
    doc: path.join(ROOT, 'docs', 'frontend', 'assets-manifest.md'),
  };
}

function runManifest(full) {
  const r = runNode('asset-manifest.js', ['--quiet']);
  if (r.code !== 0) return { ok: false, error: (r.out + r.err).trim() };
  return Object.assign({ ok: true, log: r.out.trim().split('\n').slice(0, 14) }, manifestSummary(full));
}

function runApplyAssets() {
  const r = runNode('apply-assets.js');
  const status = JSON.parse(fs.readFileSync(MANIFEST_JSON, 'utf8'));
  return {
    ok: r.code === 0, log: (r.out + r.err).trim().split('\n').slice(0, 40),
    summary: status.summary, doc: path.join(ROOT, 'docs', 'frontend', 'assets-manifest.md'),
  };
}

/** 读工作区当前布局表（布局台启动时载入；没有就返回 null） */
function readLayout() {
  if (!fs.existsSync(RAW)) return null;
  try { return JSON.parse(fs.readFileSync(RAW, 'utf8')); } catch (e) { return null; }
}

function status() {
  const raw = fs.existsSync(RAW) ? fs.statSync(RAW).mtimeMs : 0;
  const data = fs.existsSync(path.join(ROOT, 'public', 'layout-data.js')) ? fs.statSync(path.join(ROOT, 'public', 'layout-data.js')).mtimeMs : 0;
  let man = null;
  try { man = JSON.parse(fs.readFileSync(MANIFEST_JSON, 'utf8')).summary; } catch (e) { /* 还没生成 */ }
  return {
    ok: true, root: ROOT, raw: RAW, rawExists: fs.existsSync(RAW),
    stale: raw > data, // 导出比生成物新 → 需要重新 import
    manifestGenerated: man !== null, manifest: man,
    inbox: path.join(ROOT, 'assets-inbox'),
    inboxFiles: fs.existsSync(path.join(ROOT, 'assets-inbox')) ? fs.readdirSync(path.join(ROOT, 'assets-inbox'), { recursive: true }).length : 0,
  };
}

/** 工厂：返回 http.Server（测试可以 listen(0) 后直接打接口，不必起子进程） */
function createLabServer() {
  return http.createServer(handleRequest);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = decodeURIComponent(url.pathname);
  try {
    if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '');
    // 布局台的常用入口都认（人习惯敲 index.html / lab / 完整文件路径）
    if (req.method === 'GET' && (p === '/' || p === '/lab' || p === '/lab.html' || p === '/index.html'
      || p === '/index.htm' || p.endsWith('/lab.html') || p.endsWith('/index.html'))) return serveFile(res, LAB);
    if (req.method === 'GET' && p === '/favicon.ico') return send(res, 204, 'text/plain', '');
    if (req.method === 'GET' && p.startsWith('/public/')) return serveFile(res, path.join(ROOT, 'public', p.slice('/public/'.length)));
    if (req.method === 'GET' && p.startsWith('/assets/')) return serveFile(res, path.join(ROOT, 'public', 'assets', p.slice('/assets/'.length)));
    if (req.method === 'GET' && p === '/api/status') return sendJson(res, status());
    // 布局台启动时用它载入**工作区当前的布局表**（没有这个，页面只会拿内置示例当起点，一点存盘就覆盖现有设计）
    if (req.method === 'GET' && p === '/api/layout') {
      if (!fs.existsSync(RAW)) return sendJson(res, { ok: false, error: '工作区还没有布局表（' + RAW + '）', hint: '先在布局台里画一版，点「存到工作区」就会生成' });
      let bundle = null;
      try { bundle = JSON.parse(fs.readFileSync(RAW, 'utf8')); }
      catch (e) { return sendJson(res, { ok: false, error: '布局表不是合法 JSON：' + e.message, path: RAW }); }
      return sendJson(res, { ok: true, path: RAW, bundle: bundle, mtime: fs.statSync(RAW).mtimeMs });
    }
    if (req.method === 'POST' && p === '/api/save-layout') return sendJson(res, saveLayout(await readBody(req)));
    if (req.method === 'POST' && p === '/api/manifest') return sendJson(res, runManifest(url.searchParams.get('full') === '1'));
    // GET = 读**上次**生成的清单（不重算）：方便在浏览器地址栏或 curl 里看，也让"只读"语义站得住
    if (req.method === 'GET' && p === '/api/manifest') {
      if (!fs.existsSync(MANIFEST_JSON)) {
        return sendJson(res, { ok: false, error: '还没生成过素材清单', hint: '点布局台的「📋 素材清单」，或跑 npm run assets:manifest' });
      }
      return sendJson(res, Object.assign({ ok: true, cached: true }, manifestSummary(url.searchParams.get('full') === '1')));
    }
    if (req.method === 'POST' && p === '/api/apply-assets') return sendJson(res, runApplyAssets());
    if (req.method === 'POST' && p === '/api/apply-all') {
      const saved = saveLayout(await readBody(req));
      if (!saved.ok) return sendJson(res, saved);
      return sendJson(res, { ok: true, saved: saved, manifest: runManifest(true), assets: runApplyAssets() });
    }
    // 浏览器**导航**打错路径：重定向回首页（否则用户会在页面上看到一段 JSON，以为坏了）
    if (req.method === 'GET' && p.indexOf('/api/') !== 0 && wantsHtml(req)) {
      res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
      return res.end();
    }
    return sendJson(res, {
      ok: false, error: 'not_found', path: p,
      routes: ['GET /', 'GET /lab.html', 'GET /api/status', 'GET /api/layout', 'POST /api/save-layout',
        'POST /api/manifest', 'POST /api/apply-assets', 'POST /api/apply-all'],
      hint: '路径打错了。这个服务的首页就是布局台：http://127.0.0.1:' + PORT + '/ ；'
        + '页面里的按钮只会调用上面列出的 /api/* 接口。',
    }, 404);
  } catch (e) {
    return sendJson(res, { ok: false, error: e && e.message ? e.message : String(e) });
  }
}

const portArg = process.argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 4319;

module.exports = { createLabServer, status, saveLayout, runManifest, runApplyAssets, readLayout, RAW, LAB, ROOT, PORT };

if (require.main === module) createLabServer().listen(PORT, '127.0.0.1', () => {
  console.log('布局工具已启动：http://127.0.0.1:' + PORT + '/');
  console.log('  工作区：' + ROOT);
  console.log('  导出 JSON → ' + RAW + '（「存到工作区」按钮）');
  console.log('  素材清单 → docs/frontend/assets-manifest.md（「素材清单」按钮）');
  console.log('  收件夹   → ' + path.join(ROOT, 'assets-inbox') + '（把图丢进去，点「归位素材」）');
});
