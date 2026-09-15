// mount/render.js —— Box → HTML 与 HTML → Box（frontend-spec §3.1/§6.0；纯字符串，无 DOM 依赖）
// 每个盒子产出 <div class="dl-box dl-<kind>" data-box-id data-box-x/y/w/h/z/visible data-action|data-goto data-payload…>；
// collectBoxes 反向解析（坐标事实源回读 → verifyLayout 输入）。

export function boxToHtml(box, index) {
  const b = box || {};
  const id = b.id || `box_${index}`;
  // style 支持多 token（空格分隔）——每段独立加 .dl- 前缀（'right muted' → dl-right dl-muted）
  const styleCls = String(b.style || '').trim().split(/\s+/).filter(Boolean).map((t) => `dl-${t}`);
  const cls = ['dl-box', `dl-${b.kind || 'generic'}`, ...styleCls, b.visible === false ? 'dl-hidden' : '', b.disabled ? 'dl-disabled' : ''].filter(Boolean).join(' ');
  const attrs = [
    // ★id 属性必填：mount/injectBoxGeom 经 getElementById(box.id) 注入几何（F5 P1）。此前只写 data-box-id →
    // 取不到元素 → 全部盒子裸堆在 (0,0)（浏览器实测：1280×64 的 header 实测 rect=94.84×18.5）。
    `id="${escapeAttr(id)}"`,
    `data-box-id="${id}"`,
    `data-box-x="${b.x === undefined ? 0 : b.x}"`,
    `data-box-y="${b.y === undefined ? 0 : b.y}"`,
    `data-box-w="${b.w === undefined ? 0 : b.w}"`,
    `data-box-h="${b.h === undefined ? 0 : b.h}"`,
    `data-box-z="${b.z === undefined ? 0 : b.z}"`,
    `data-box-parent="${b.parent || ''}"`,
    `data-box-kind="${b.kind || 'generic'}"`,
  ];
  // 可选标注统一表格驱动（F2：避免离散 if 的分支计数发散）
  const optional = [
    [b.style, 'style', `data-box-style="${escapeAttr(b.style)}"`],
    [b.action, 'action', `data-action="${b.action}"`],
    [b.goto, 'goto', `data-goto="${b.goto}"`],
    [b.payload !== undefined, 'payload', `data-payload="${escapeAttr(JSON.stringify(b.payload))}"`],
    [b.detail !== undefined, 'detail', `data-detail="${escapeAttr(b.detail)}"`],
    [b.disabled, 'disabled', 'data-box-disabled="1"'], // 忙态/门控禁用（视觉类 dl-disabled 已入 cls）
  ];
  for (const [cond, , attr] of optional) {
    if (cond) attrs.push(attr);
  }
  const text = (typeof b.text === 'string' ? b.text : '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const detail = (typeof b.detail === 'string' ? b.detail : '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<div class="${cls}" ${attrs.join(' ')}${b.visible === false ? ' hidden' : ''}><span class="dl-t">${text}</span>${detail ? `<span class="dl-d">${detail}</span>` : ''}</div>`;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); // > 必须转义：否则外层属性正则 [^>]* 截断（F2 实测）
}

export function boxesToHtml(boxes) {
  return (boxes || []).map((b, i) => boxToHtml(b, i)).join('\n');
}

const BOX_RE = /<div class="[^"]*dl-box[^"]*"([^>]*)>/g;
const ATTR_RE = /data-box-([a-z]+)="([^"]*)"/g;

// HTML → Box[]（坐标事实源回读；供 verifyLayout 与测试；仅解析封闭串）
export function collectBoxes(html) {
  const out = [];
  const src = String(html || '');
  let m;
  while ((m = BOX_RE.exec(src)) !== null) {
    const attrs = {};
    const attrsSrc = m[1];
    let a;
    ATTR_RE.lastIndex = 0;
    while ((a = ATTR_RE.exec(attrsSrc)) !== null) attrs[a[1]] = a[2];
    if (attrs.id === undefined) continue;
    const box = {
      id: attrs.id,
      kind: attrs.kind || 'generic',
      parent: attrs.parent || null,
      x: num(attrs.x), y: num(attrs.y), w: num(attrs.w), h: num(attrs.h),
      z: num(attrs.z),
      visible: !/hidden/.test(attrsSrc), // hidden 类/属性任一出现 → 不可见（class 与 attrs 都带 dl-hidden/hidden）
      text: extractText(src, m.index),
    };
    const am = /data-action="([^"]*)"/.exec(attrsSrc);
    if (am) box.action = am[1];
    const gm = /data-goto="([^"]*)"/.exec(attrsSrc);
    if (gm) box.goto = gm[1];
    const pm = /data-payload="([^"]*)"/.exec(attrsSrc);
    if (pm) {
      try {
        box.payload = JSON.parse(pm[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      } catch (e) { box.payload = null; }
    }
    const dm = /data-detail="([^"]*)"/.exec(attrsSrc);
    if (dm) box.detail = dm[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const sm = /data-box-style="([^"]*)"/.exec(attrsSrc);
    if (sm) box.style = sm[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    if (/data-box-disabled="1"/.test(attrsSrc)) box.disabled = true;
    out.push(box);
  }
  return out;
}

function num(s) {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function extractText(src, fromIdx) {
  // 取该块第一个 <span class="dl-t">…</span>
  const close = src.indexOf('</div>', fromIdx);
  const seg = close === -1 ? src.slice(fromIdx) : src.slice(fromIdx, close);
  const tm = /<span class="dl-t">([^<]*)<\/span>/.exec(seg);
  return tm ? tm[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<') : '';
}

// 事件标注校验（纯）：boxes 中 action/goto 的 id 唯一性
export function validateBoxIds(boxes) {
  const seen = new Set();
  const dups = [];
  for (const b of boxes || []) {
    if (seen.has(b.id)) dups.push(b.id);
    seen.add(b.id);
  }
  return { ok: dups.length === 0, dups };
}