'use strict';
/* views/editor.js —— AI 编辑器屏（frontend-spec §6.2 + docs/screens.md editor 表）。
 * toolbox(0,64,120,592)/workspace(120,64,1024,432)/panel_right(1144,64,136,592)/
 * btn_validate(1156,80,112,32)/btn_compile(1156,120,112,32)/btn_run(1156,160,112,32)/
 * hash(1156,216,112,40)/errCount(1156,272,112,24)/errors(120,496,1024,160)/loop_forever 占位(144,88,200,48)。
 */
import { box, panel, button, verifyLayout } from '../ui/layout.js';
import { boxesToHtml } from './html.js';

const EDITOR_BOXES = {
  toolbox: { x: 0, y: 64, w: 120, h: 592, z: 2 },
  workspace: { x: 120, y: 64, w: 1024, h: 432, z: 2 },
  loop_forever: { x: 144, y: 88, w: 200, h: 48, z: 3 },
  panel_right: { x: 1144, y: 64, w: 136, h: 592, z: 2 },
  btn_validate: { x: 1156, y: 80, w: 112, h: 32, z: 3 },
  btn_compile: { x: 1156, y: 120, w: 112, h: 32, z: 3 },
  btn_run: { x: 1156, y: 160, w: 112, h: 32, z: 3 },
  hash: { x: 1156, y: 216, w: 112, h: 40, z: 3 },
  errCount: { x: 1156, y: 272, w: 112, h: 24, z: 3 },
  errors: { x: 120, y: 496, w: 1024, h: 160, z: 2 },
};

export function editorLayout(state) {
  const s = state;
  const draft = s.aiDraft || { errors: [], compiling: false, hash: null };
  const errors = draft.errors || [];
  const compiling = !!draft.compiling;
  const boxes = [
    panel('toolbox', EDITOR_BOXES.toolbox.x, EDITOR_BOXES.toolbox.y, EDITOR_BOXES.toolbox.w, EDITOR_BOXES.toolbox.h),
    panel('workspace', EDITOR_BOXES.workspace.x, EDITOR_BOXES.workspace.y, EDITOR_BOXES.workspace.w, EDITOR_BOXES.workspace.h),
    panel('panel_right', EDITOR_BOXES.panel_right.x, EDITOR_BOXES.panel_right.y, EDITOR_BOXES.panel_right.w, EDITOR_BOXES.panel_right.h),
    panel('errors', EDITOR_BOXES.errors.x, EDITOR_BOXES.errors.y, EDITOR_BOXES.errors.w, EDITOR_BOXES.errors.h),
    box('loop_forever', 'text', EDITOR_BOXES.loop_forever.x, EDITOR_BOXES.loop_forever.y, EDITOR_BOXES.loop_forever.w, EDITOR_BOXES.loop_forever.h, { z: 3, parent: 'workspace', text: 'while(true) 主循环（预置，不可删除）' }),
  ];
  // panel_right 三按钮 + hash + 错误计数
  boxes.push(button('btn_validate', EDITOR_BOXES.btn_validate.x, EDITOR_BOXES.btn_validate.y, { z: 3, parent: 'panel_right', style: 'ghost', w: EDITOR_BOXES.btn_validate.w, h: EDITOR_BOXES.btn_validate.h, text: '校验', action: compiling ? null : 'ai/edit', payload: { manual: true } }));
  boxes.push(button('btn_compile', EDITOR_BOXES.btn_compile.x, EDITOR_BOXES.btn_compile.y, { z: 3, parent: 'panel_right', style: 'ghost', w: EDITOR_BOXES.btn_compile.w, h: EDITOR_BOXES.btn_compile.h, text: compiling ? '编译中…' : '编译', action: compiling ? null : 'ai/compile', disabled: compiling }));
  boxes.push(button('btn_run', EDITOR_BOXES.btn_run.x, EDITOR_BOXES.btn_run.y, { z: 3, parent: 'panel_right', style: 'ghost', w: EDITOR_BOXES.btn_run.w, h: EDITOR_BOXES.btn_run.h, text: '试运行', action: compiling ? null : 'ai/run', payload: { opponent: 'kiter' }, disabled: compiling }));
  boxes.push(box('hash', 'text', EDITOR_BOXES.hash.x, EDITOR_BOXES.hash.y, EDITOR_BOXES.hash.w, EDITOR_BOXES.hash.h, { z: 3, parent: 'panel_right', text: draft.hash ? `hash ${String(draft.hash).slice(0, 8)}` : 'hash --（编译后显示）' }));
  boxes.push(box('errCount', 'text', EDITOR_BOXES.errCount.x, EDITOR_BOXES.errCount.y, EDITOR_BOXES.errCount.w, EDITOR_BOXES.errCount.h, { z: 3, parent: 'panel_right', text: `错误 ${errors.length}` }));
  // errors 底栏：path + code + message 行（点击 → 高亮）
  if (errors.length === 0) {
    boxes.push(box('errors_none', 'text', 132, 512, 1000, 24, { z: 3, parent: 'errors', text: '暂无校验错误 —— 编辑积木后自动校验（/ai/validate）' }));
  } else {
    errors.slice(0, 5).forEach((e, i) => {
      boxes.push(box(`err${i + 1}`, 'chip', 132, 508 + i * 26, 1000, 22, { z: 3, parent: 'errors', text: `${e.path || 'body'} · ${e.code || 'error'} · ${e.message || ''}`, action: 'editor/highlight', payload: { path: e.path || 'body' } }));
    });
  }
  return boxes;
}

export function editorHtml(state) {
  return boxesToHtml(editorLayout(state));
}
