'use strict';
/* views/html.js —— Box → HTML（视图层纯函数，frontend-spec §6 开头约定）。
 * 所有可交互元素带 data-action（action type）与 data-payload（JSON 参数）与 data-box-id；
 * collectBoxes 从 HTML 字符串静态解析坐标（jsdom 无布局引擎也能断言，§2.3/§3.6）。
 */

export function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 盒 → HTML：坐标内联注入（布局唯一事实源是 layout 函数，CSS 只做盒内视觉）
export function boxHtml(b) {
  const cls = ['dl-box', `dl-${b.kind}`, b.style ? `dl-style-${b.style}` : null, b.disabled ? 'dl-disabled' : null]
    .filter(Boolean).join(' ');
  const action = b.action ? ` data-action="${escapeHtml(b.action)}"` : '';
  const payload = b.payload !== undefined && b.payload !== null ? ` data-payload="${escapeHtml(JSON.stringify(b.payload))}"` : '';
  const valueKey = b.valueKey ? ` data-value-key="${escapeHtml(b.valueKey)}"` : '';
  const options = b.options && b.options.length
    ? `<select>${b.options.map((x) => `<option value="${escapeHtml(x)}"${x === b.value ? ' selected' : ''}>${escapeHtml(x)}</option>`).join('')}</select>`
    : (b.html ? b.html : '');
  const style = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;z-index:${b.z};`;
  const text = b.text === undefined || b.text === null ? '' : `<span>${escapeHtml(b.text)}</span>`;
  return `<div class="${cls}" data-box-id="${escapeHtml(b.id)}" style="${style}"${action}${payload}${valueKey}>${options || text}</div>`;
}

export function boxesToHtml(boxes) {
  return (boxes || []).map((b) => (b.html ? b.html : boxHtml(b))).join('');
}

// 静态推算：解析 data-box-id + 内联坐标 → Box 简表（不依赖浏览器布局引擎）
export function collectBoxes(html) {
  const out = [];
  if (typeof html !== 'string') return out;
  const re = /<div class="dl-box[^"]*" data-box-id="([^"]*)" style="left:(-?\d+)px;top:(-?\d+)px;width:(-?\d+)px;height:(-?\d+)px;z-index:(\d+);"[^>]*(data-visible="false")?[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ id: m[1], x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]), z: Number(m[6]), visible: true });
  }
  return out;
}
