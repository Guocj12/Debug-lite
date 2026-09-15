'use strict';
/* ui/sizes.js —— 组件尺寸常量（frontend-spec §3.2；布局计算的唯一来源之一）。
 * 坐标纪律：所有布局坐标为整数 CSS px（Math.round）；间距只用 SPACES。
 */
export const VIEW = { w: 1280, h: 720 };      // 设计基准视口（§0.4）
export const HEADER_H = 64;                   // 外壳 header 高（§6.0）
export const CANVAS = { w: 1024, h: 128 };    // 战斗画布（引擎 px = CSS px，§0.4）

export const SIZES = {
  button: { w: 160, h: 40 },                  // primary/danger
  buttonGhost: { w: 96, h: 32 },              // ghost
  listItem: { h: 56 },
  gridCell: { w: 168, h: 108 },               // 物品/技能卡（品质描边 2px）
  gridGap: 16,
  modal: { w: 480, maxH: 560 },
  toast: { w: 320, h: 48 },
  field: { h: 40 },                           // 全宽输入框
  tab: { w: 120, h: 40 },
  badge: 24,                                  // 段位/品质圆徽
  hpBar: { w: 96, h: 8 },                     // 回放 HUD 血条
  controls: { h: 56 },                        // 回放控制条
};

export const SPACES = { s1: 4, s2: 8, s3: 12, s4: 16, s5: 24, s6: 32, s7: 48, s8: 64 };
export const GRID_GAP = SPACES.s4; // grid 单元格间距（§3.2 GridCell gap 16）

// 全屏共用外壳三件套（docs/screens.md 每屏盒子表首三行；坐标即该表，单一事实源）
export const SHELL = {
  logo: { x: 16, y: 9, w: 180, h: 46, z: 1 },
  tierBadge: { x: 1080, y: 20, w: 72, h: 24, z: 1 },
  seedLit: { x: 1160, y: 20, w: 112, h: 24, z: 1 },
};
