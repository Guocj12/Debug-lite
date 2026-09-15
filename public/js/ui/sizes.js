// ui/sizes.js —— 尺寸常量库（frontend-spec §3.2；视觉令牌数值镜像；禁止魔法数字）
export const SIZES = {
  button: { w: 160, h: 40 },
  buttonGhost: { w: 96, h: 32 },
  listItem: { h: 56 },
  gridCell: { w: 168, h: 108 },
  gridGap: 16, // GridCell 间距（§3.2；= GRID_GAP，单值供 SIZES 消费者使用）
  modal: { w: 480, maxH: 560 },
  toast: { w: 320, h: 48 },
  field: { h: 40 },
  tab: { w: 120, h: 40 },
  badge: 24,
  headerH: 64,
  viewportW: 1280,
  viewportH: 720,
};

export const SPACES = { s1: 4, s2: 8, s3: 12, s4: 16, s5: 24, s6: 32, s7: 48, s8: 64 };
export const GRID_GAP = SPACES.s4; // grid 单元格间距（§3.2 GridCell gap 16）
// 全屏共用外壳三件套（docs/screens.md 每屏盒子表首三行，坐标即该表；单一事实源）
export const SHELL = {
  logo: { x: 16, y: 9, w: 180, h: 46, z: 1 },
  tierBadge: { x: 1080, y: 20, w: 72, h: 24, z: 1 },
  seedLit: { x: 1160, y: 20, w: 112, h: 24, z: 1 },
};