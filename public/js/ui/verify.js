// ui/verify.js —— 布局自检器（frontend-spec §3.5；纯函数；每次 mount 渲染后调用）
// 输出 [{boxId, issue, detail}]：clip 越界 / overlap 重叠 / zero 不显示 / zconflict 覆盖。
import { SIZES } from './sizes.js';

function rectsOverlap(a, b) {
  const ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx2 = b.x + b.w, by2 = b.y + b.h;
  return a.x < bx2 && ax2 > b.x && a.y < by2 && ay2 > b.y;
}

export function verifyLayout(boxes) {
  const list = boxes || [];
  const issues = [];
  for (const box of list) {
    // clip：越界（fullscreen 遮罩除外）
    if (!box.fullscreen && (box.x < 0 || box.y < 0 || box.x + box.w > SIZES.viewportW || box.y + box.h > SIZES.viewportH)) {
      issues.push({ boxId: box.id, issue: 'clip', detail: `x=${box.x} y=${box.y} w=${box.w} h=${box.h}` });
    }
    // zero：零尺寸（visible:false 但被引用）
    if (box.w <= 0 || box.h <= 0) {
      issues.push({ boxId: box.id, issue: 'zero', detail: `w=${box.w} h=${box.h}` });
    } else if (box.visible === false && list.some((o) => o.parent === box.id)) {
      issues.push({ boxId: box.id, issue: 'zero', detail: 'hidden 但被子盒引用' });
    }
    // zconflict：父子 z 颠倒 / 遮罩低于其下内容
    if (box.parent) {
      const parent = list.find((o) => o.id === box.parent);
      if (parent && box.z <= parent.z) {
        issues.push({ boxId: box.id, issue: 'zconflict', detail: `子 z=${box.z} ≤ 父 z=${parent.z}` });
      }
    }
    if (box.kind === 'modal-mask') {
      const above = list.filter((o) => o.id !== box.id && o.parent !== box.id && o.z > box.z);
      if (above.length > 0) {
        issues.push({ boxId: box.id, issue: 'zconflict', detail: `遮罩 z=${box.z} 低于其下内容 ${above.map((o) => o.id).join(',')}` });
      }
    }
  }
  // overlap：同 z 两可见盒相交（父-子盒除外；region 容器豁免——屏内容画在其上属设计语义）
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (!a.visible || !b.visible || a.z !== b.z) continue;
      if (a.parent === b.id || b.parent === a.id) continue;
      if (a.kind === 'region' || b.kind === 'region') continue; // F2：shell_main 与其上内容共存
      if (rectsOverlap(a, b)) {
        issues.push({ boxId: a.id, issue: 'overlap', detail: `与 ${b.id} 相交（z=${a.z}）` });
      }
    }
  }
  return { ok: issues.length === 0, issues };
}