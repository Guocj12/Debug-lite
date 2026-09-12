# server/data/

数据表（P0-6 落地 + T-DC-1/2 校验；机制在代码、数值在表，L9）：

- `battle-config.json`（D-117：空间/速度/碰撞/防御/超时等全部战斗数值）
- `role-templates.json` / `skill-templates.json` / `plugins.json` / `qualities.json` / `items-config.json` / `unlock.json`
- `schema.js`：数据表结构校验器（D-110~D-118；**不得出现 `bulletSpeed`**）

变更纪律（`tasks.md` §10.6）：改数据表必须同步 `docs/items-data.md` 且 T-DC-1/2 保持绿。