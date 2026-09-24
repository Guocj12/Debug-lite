'use strict';
/* tests/frontend/render-escaping.test.js —— 「用户可控文本 → HTML」转义不变量（机器核对）
 *
 * 权威：
 *   · docs/frontend/00-rules.md §1（绘制原语只有 按钮/文字/输入框）§4（字段名可追溯到真实响应）；
 *   · docs/frontend/03-hub-warehouse-loadout.md §3（`render.js` = **唯一 DOM 写入点**）。
 *
 * 为什么必须钉住（本次新增的直接原因）：
 *   `render.js` 把视图模型拼成 HTML 字符串，而**服务端不消毒**这些文本 ——
 *     · 昵称：`archive.isValidNickname` 只校验 `1 ≤ length ≤ 16`（server/store/archive.js:212），字符集不限；
 *     · AI 名：`createAi` 只校验 `1..24` 字符（server/account.js:633），字符集不限。
 *   于是 `昵称 = <b>hack</b>`、`AI 名 = <svg/onload=x>` 都能原样落库并原样返回（ESC-4 实测）。
 *   ⇒ 转义是**唯一的防线**，且只能存在于 `render.js`。一旦有人删掉某个 `esc()`，就是存储型 XSS。
 *
 * 覆盖：
 *   ESC-1 逐插值点转义（title/notice/result/hint/lines/rows/confirm/modal/fields/buttons）
 *   ESC-2 属性逃逸：引号闭合后无法注入新标签/新属性；`<button` 数量 = 请求绘制的按钮数
 *   ESC-3 esc() 字符表（& < > "）、null/undefined/数字、单引号属性禁用（esc 不转义 '）
 *   ESC-4 真实 HTTP：恶意昵称/AI 名原样落库（证明服务端不消毒）→ format → render 后无害
 *   ESC-5 结构：render.js 是纯字符串渲染（不碰 DOM），DOM 写入点不在本文件
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, register, authed, request } = require('../helpers/http.js');
const format = require('../../public/format.js');
const render = require('../../public/render.js');
const ranked = require('../../server/ranked.js');

const REPO = path.join(__dirname, '..', '..');
const RENDER_SRC = fs.readFileSync(path.join(REPO, 'public', 'render.js'), 'utf8');

// 会真正打断 HTML 的载荷（含标签注入与属性闭合两种）
const TAG_PAYLOAD = '<b>hack</b>';
const ATTR_PAYLOAD = '"><img src=x onerror=alert(1)>';
// **标记**注入成功后才会出现的子串（转义正确时一个都不该出现）。
// 注意：只列标记本身 —— 形如 `onerror=`、` src=x` 的**纯文本**在转义后仍会出现且无害，
// 拿它们当判据会得到假红（第一版就是这么错的）。
const FORBIDDEN = ['<b>hack', '<img', '<script', '<svg'];

function assertClean(html, label) {
  for (const bad of FORBIDDEN) {
    assert.ok(!html.includes(bad), `${label}：输出出现了未转义的 ${bad}\n${html}`);
  }
}

// 一个"每个插值点都塞了恶意载荷"的视图模型
function hostileVm() {
  const btn = (label, extra) => Object.assign({
    action: ATTR_PAYLOAD, label: label + TAG_PAYLOAD, kind: 'button',
    uid: ATTR_PAYLOAD, slot: ATTR_PAYLOAD, bucket: ATTR_PAYLOAD,
    playerId: ATTR_PAYLOAD, publicId: ATTR_PAYLOAD,
    // 提交③：配置编辑器的位置寻址属性（data-pos / data-idx / data-ai-id）同样是插值点
    pos: ATTR_PAYLOAD, idx: ATTR_PAYLOAD, aiId: ATTR_PAYLOAD,
  }, extra || {});
  return {
    title: TAG_PAYLOAD,
    hint: TAG_PAYLOAD,
    notice: { kind: ATTR_PAYLOAD, text: TAG_PAYLOAD },
    result: { kind: ATTR_PAYLOAD, text: TAG_PAYLOAD },
    lines: [TAG_PAYLOAD, ATTR_PAYLOAD],
    rows: [{ text: TAG_PAYLOAD, buttons: [btn('row-')] }],
    confirm: { text: TAG_PAYLOAD, buttons: [btn('cf-')] },
    modal: {
      title: TAG_PAYLOAD, hint: TAG_PAYLOAD, lines: [TAG_PAYLOAD], buttons: [btn('md-')],
      // 提交③：弹窗内的候选行列表（插件/AI 候选：一行一个可点按钮）
      rows: [{ text: TAG_PAYLOAD, buttons: [btn('mr-')] }],
    },
    fields: [{ name: ATTR_PAYLOAD, label: TAG_PAYLOAD, type: ATTR_PAYLOAD, value: ATTR_PAYLOAD }],
    buttons: [btn('f-'), btn('s-', { kind: 'submit' })],
    enterAction: ATTR_PAYLOAD,
  };
}

test('ESC-1 每个插值点都转义：恶意载荷全部变成实体，不产生新标签', () => {
  const vm = hostileVm();
  const html = render.render(vm);

  assertClean(html, 'ESC-1');
  // 转义是"可见降级"而非"静默丢弃"：原文以实体形式仍在（玩家能看到自己起的名字）
  assert.ok(html.includes('&lt;b&gt;hack&lt;/b&gt;'), '被转义的标签文本应当保留为实体');
  assert.ok(html.includes('&quot;&gt;&lt;img'), '属性载荷应当以实体形式保留');
  // 每个插值点都真的出现过（防止"因为字段没渲染所以看着干净"的假绿）
  for (const marker of ['f-', 's-', 'row-', 'cf-', 'md-', 'mr-']) {
    assert.ok(html.includes(marker + '&lt;b&gt;hack'), `按钮 ${marker} 的 label 未被渲染`);
  }
  assert.ok(html.includes('<h3>'), 'modal 标题块应在');
  assert.ok(html.includes('class="hint"'), 'hint 块应在');
  assert.ok(html.includes('class="modal-rows"'), '提交③：弹窗内的候选行列表应在');
});

test('ESC-2 属性逃逸：引号被转义 ⇒ 无法闭合属性或注入新按钮/新属性', () => {
  const vm = hostileVm();
  const html = render.render(vm);

  // 载荷试图闭合 value/data-* 后塞入新属性
  assert.ok(!html.includes('data-x="'), '属性名注入成功（引号未转义）');
  assert.ok(!html.includes('<img src=x'), '标签注入成功（尖括号未转义）');
  // 画出来的 <button 只应来自 vm 中声明的 6 个按钮（form 的 2 个 + row / confirm / modal / modal.rows 各 1）
  assert.strictEqual((html.match(/<button/g) || []).length, 6, '按钮数量与请求绘制数不一致（疑似注入出了按钮）');
  // 属性一律双引号包裹：esc() 不转义单引号，所以绝不允许单引号属性写法
  assert.ok(!/='\s*\+/.test(RENDER_SRC), "render.js 出现单引号属性拼接：esc() 不转义 '，必须改回双引号");
});

test('ESC-3 esc() 字符表与边界值', () => {
  assert.strictEqual(render.esc('&<>"'), '&amp;&lt;&gt;&quot;');
  assert.strictEqual(render.esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  // 顺序：& 先于 < >（否则 &lt; 会被二次转义成 &amp;lt;）
  assert.strictEqual(render.esc('&lt;'), '&amp;lt;');
  assert.strictEqual(render.esc(null), '');
  assert.strictEqual(render.esc(undefined), '');
  assert.strictEqual(render.esc(0), '0');
  assert.strictEqual(render.esc(42), '42');
  // 非字符串输入同样经 esc（label 为数字时不得 TypeError）
  const html = render.render({ title: 7, lines: [0], buttons: [{ action: 'a', label: 9 }] });
  assert.ok(html.includes('<h2>7</h2>') && html.includes('>9</button>'), '非字符串插值应被字符串化');
});

test('ESC-4 真实 HTTP：恶意昵称/AI 名原样落库（服务端不消毒）→ format → render 后无害', async (t) => {
  const s = await startServer();
  t.after(() => s.cleanup());
  try {
    // 注册即带恶意昵称（14 字符 ≤ 16，通过 isValidNickname）
    const acc = await register(s.port, undefined, undefined, { nickname: TAG_PAYLOAD });
    assert.strictEqual(acc.status, 200, `注册失败：${JSON.stringify(acc.res.body)}`);
    assert.strictEqual(acc.nickname, TAG_PAYLOAD, '昵称应原样接受（说明服务端不做字符集消毒）');

    const me = await request(s.port, 'GET', '/api/v1/me', undefined, authed(acc.token));
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.data.nickname, TAG_PAYLOAD, 'GET /me 原样返回昵称（HTML 原文）');

    // 走真实投影 + 真实渲染（与浏览器同构：format.viewModel → render.render，即 app.js 的唯一 DOM 写入点）
    const env = me.body;
    const baseState = {
      profile: env, session: { isAdmin: false }, busy: false, notice: null,
      form: {}, modal: null, settings: null, warehouse: null, box: null, aiLibrary: null,
    };
    const hubHtml = render.render(format.viewModel(Object.assign({}, baseState, { view: 'hub' })));
    const profileHtml = render.render(format.viewModel(Object.assign({}, baseState, { view: 'profile' })));
    assertClean(hubHtml, 'ESC-4/hub');
    assertClean(profileHtml, 'ESC-4/profile');
    assert.ok(hubHtml.includes('&lt;b&gt;hack&lt;/b&gt;'), 'hub 摘要应显示转义后的昵称');
    assert.ok(profileHtml.includes('&lt;b&gt;hack&lt;/b&gt;'), '用户详情应显示转义后的昵称');

    // AI 名同属玩家可控文本（1..24 字符，字符集不限）
    const aiName = '<svg/onload=x>';
    const created = await request(s.port, 'POST', '/api/v1/me/ai', {
      name: aiName, program: ranked.buildDefaultLoadout().ai,
    }, authed(acc.token));
    assert.strictEqual(created.status, 200, `建 AI 失败：${JSON.stringify(created.body)}`);
    const list = await request(s.port, 'GET', '/api/v1/me/ai', undefined, authed(acc.token));
    const names = (list.body.data.items || []).map((it) => it.name);
    assert.ok(names.includes(aiName), 'AI 名应原样落库（服务端不消毒）⇒ 任何渲染 AI 名的屏必须走 render.js 转义');
    assert.strictEqual(render.esc(aiName), '&lt;svg/onload=x&gt;', 'render.esc 必须中和 AI 名');
  } catch (err) {
    throw err;
  }
});

test('ESC-5 结构：render.js 是纯字符串渲染，不直接接触 DOM', () => {
  assert.ok(!/\bdocument\b/.test(RENDER_SRC), 'render.js 不应引用 document（DOM 写入点只在 app.js）');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(RENDER_SRC), 'render.js 不应使用 HTML 注入 API');
  // esc 必须是被普遍调用的（结构下限：远多于插值函数数），防止"函数还在但没人用"
  const escCalls = (RENDER_SRC.match(/\besc\(/g) || []).length;
  assert.ok(escCalls >= 25, `render.js 中 esc( 调用过少（${escCalls}）：疑似有插值绕过了转义`);
});
