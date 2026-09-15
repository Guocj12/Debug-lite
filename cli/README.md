# cli/

命令行"操作台"（P0-8；本轮唯一的前端替代入口，L14）。

- `index.js`：子命令 `box / wh / panel / ai / battle / replay / ranked / log / health / data`（`tasks.md` §2.4）
- **只走 HTTP，不 require core** → 同时是接口完整性验收工具（T-CLI-1 闭环）
- 退出码：`0` 成功 / `1` 业务拒绝 / `2` 参数错误