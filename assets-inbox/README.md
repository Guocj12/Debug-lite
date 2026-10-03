# 素材收件夹（assets-inbox/）

把你准备好的 UI 图片**直接丢进这个文件夹**（可以带子目录、可以是 PNG/JPG/WebP，
矢量图标用 SVG），然后跑一次归位命令，或点布局台的「🎨 归位素材」：

```bash
node runtime/apply-assets.js          # 归位（改名 / 转 WebP / 缩放 → public/assets/）
node runtime/apply-assets.js --dry    # 只预演，不动文件
node runtime/apply-assets.js --inbox D:\我的素材   # 换一个收件夹
```

脚本会：**识别 → 改名 → 转 WebP（位图，保留透明通道）→ 缩放到建议尺寸 → 放进 `public/assets/<类别>/`**，
然后打印「已归位 / 名字对上了但失败 / 认不出来的文件 / 归位后仍缺什么」。

## 文件名怎么起（任选一种）

| 写法 | 例子 | 说明 |
|---|---|---|
| 直接用品类 ID（推荐） | `role_bal.png` | 最省事，清单里的 ID 就是文件名 |
| 按目标目录放 | `role/role_bal.png` | 收件夹里建同名子目录 |
| `<类别>_<ID>` | `frame_common.png` | 类别见下表 |
| 用目标文件名 | `hub_main.png` | 背景图这类按屏幕命名 |

## 类别与规格（改规格请同时改 `runtime/asset-manifest.js` 的 SPEC）

| 类别 | 目标目录 | 数量 | 建议尺寸 | 格式 | 说明 |
|---|---|---|---|---|---|
| 背景图 | `public/assets/bg/` | 1 | 1920×1080 | WebP | 主界面背景（等比铺满） |
| 界面按钮/控件 | `public/assets/ui/` | 25 | 按布局表元素框 | WebP | 名字 = 布局表元素 id（如 `btn_warehouse.webp`）；不规则形状交 PNG 透明底 |
| 角色 | `public/assets/role/` | 11 | 512×512 | WebP | 透明底正方形 |
| 技能 | `public/assets/skill/` | 4 | 256×256 | WebP | 透明底正方形 |
| 插件 | `public/assets/plugin/` | 41 | 128×128 | WebP | 同族（`_c1/_c3` 点数变体）共用一张，文件名用**族根 id** |
| AI 积木节点 | `public/assets/ai/` | 54 | 128×128 | WebP | AI 编辑器用（后补即可） |
| 包/宝箱 | `public/assets/package/` | 1 | 256×256 | WebP | 开包屏用 |
| 品质边框 | `public/assets/frame/` | 5 | 256×256 | **SVG** | 矢量；颜色见 `server/data/qualities.json` 的 `color` |
| 段位图标 | `public/assets/tier/` | 5 | 64×64 | **SVG** | 矢量；同上 |
| 技能音效（可选） | `public/assets/sfx/` | 4 | — | MP3 | 目前界面没用到，可后补 |

**完整清单（含每一项的精确文件名、中文名、用途、已有/缺失状态）见
[`docs/frontend/assets-manifest.md`](../docs/frontend/assets-manifest.md)**，或点布局台的「📋 素材清单」按钮。

> 本目录下的图片文件不入库（`.gitignore` 已排除），只有 `README.md` 会被提交；
> 归位到 `public/assets/` 之后的文件才是最终产物（会入库）。
