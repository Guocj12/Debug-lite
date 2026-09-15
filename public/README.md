# public/

**L7 层：前端（P6/R0 起，`tasks.md` §2.1）**——原生 ES Modules + CSS（D-124 零框架零构建）；只经 `/api/v1` 与后端通信（check-arch：禁止 import server 代码）。

| 目录 | 内容 |
|---|---|
| `index.html` | 唯一入口：`#app` + `#battle` 画布 + `/js/app.js`（spec §1.2） |
| `css/` | `tokens.css`（视觉令牌）+ `style.css`（盒内视觉；关键位置由 layout 决定） |
| `js/util/log.js` | 前端日志三态适配（noop/注入 logger/window.DLLog 引导） |
| `js/app.js` | 启动流程（spec §1.3；R0 为引导骨架，R1+ 接 store/视图） |

分层规则：`public/**` 为 L7；裸导入只允许 `shared/*` 与 `blockly`（R6 起，经 `/vendor/blockly/*` 静态路由）。
