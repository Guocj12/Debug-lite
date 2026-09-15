# shared/

**L-1 层：唯一允许的跨层共享模块**（`tasks.md` §2.1 分层）。除本目录外，任何跨层共享一律禁止（`scripts/check-arch.js` 检查项）。

当前模块：`log.js`（P0-4 落地）。**本 README 即 log 子系统接口冻结处**（P0-7 汇总进 `docs/interfaces.md`）。

---

# shared/log.js 契约（P0-4 冻结）

零依赖 UMD（Node `require` ↔ 浏览器/worker `window.DLLog`）。**自身不得 IO**（无 fs/net/console/stdout/process.exit）——≥info 写 stdout、`DL_LOG_FILE` 等 IO 由 **server/cli 层**经 `onRecord` sink 完成。核心模块（`server/core/**`）只使用**注入**的 logger（缺省 `nullLogger`），日志不得影响战斗结果（T-LG-5，B8 起常驻）。

## 导出

| 导出 | 类型 | 说明 |
|---|---|---|
| `LEVELS` | 冻结对象 | `{silent:-1, fatal:0, error:1, warn:2, info:3, debug:4, trace:5, all:99}` |
| `CHANNELS` | 冻结数组 | 22 通道：`rng field effects items roles skills bullets engine damage ai.ast ai.runtime unlock api cli ranked store view ui render editor perf log`（P0-5 T-DC-6 用；`ui` 为 P6 前端界面通道，见 `frontend-spec.md` §2.1，R0 接线） |
| `createLogger(options)` | 函数 | 见下 |
| `nullLogger` | 冻结单例 | 全 no-op；`on()` 恒 false；`records` 冻结空数组；禁用零成本 |
| `parseLevel(str)` | 函数 | 名字（大小写不敏感）或数字串 → 数值；非法 → `null`（env 解析用） |
| `parseChannelOverrides(str)` | 函数 | `"bullets=trace,ai.runtime=debug"` → `{channel: 数值}`；空/畸形段跳过；非法级别跳过 |

## createLogger(options)

| 选项 | 默认 | 说明 |
|---|---|---|
| `level` | env `DL_LOG_LEVEL`（非法则忽略）否则 `NODE_ENV==='production' ? 'warn' : 'debug'` | 名字或数值 |
| `channels` | `{}` | 初始通道覆盖 `{channel: 级别}`；非法级别 → `RangeError`（fail-fast） |
| `ringSize` | 2000 | 环形缓冲上限（正整数） |
| `onRecord` | 无 | sink：每条**已发出**记录回调（IO 在此完成）。**sink 抛出的异常会原样穿透 `log()` 调用方**——server/cli 层必须自行捕获（契约明示，不在本模块内吞异常） |
| `now` | `Date.now` | 时间戳注入（测试/确定性用） |

## logger 方法

| 方法 | 语义 |
|---|---|
| `log(level, channel, event, msg, data?)` | 过滤后发出；返回是否发出。非法级别/空 channel/空 event → `RangeError`。`data` 的 `cid`/`tick` 键**提升**到记录的顶层字段（并从 `data` 中移除）；其余保留 |
| `on(channel, level)` | 该级别在该通道是否会被发出（payload 构造门，§4.7 惯用法 `if (log.on(...))`；nullLogger 恒 false） |
| `fatal/error/warn/info/debug/trace(channel, event, msg, data?)` | 便捷方法，级别固定 |
| `setLevel(level)` / `setChannelLevel(channel, level)` | 全局/按通道覆盖；非法 → `RangeError` |
| `getLevel()` | 当前全局级别名 |
| `reset()` | 复位：级别与通道覆盖恢复构建时初始值；清空缓冲/计数/未知通道去重集 |
| `dump()` | `records` 的**浅拷贝快照**（改返回值不影响内部） |
| `records` | 活数组（只读约定）：已发出记录 |
| `stats()` | `{seq, dropped, records}` |

## 记录结构（冻结，§4.4）

```jsonc
{ "seq":1234, "ts":1726000000000, "cid":"t17:p1:3", "tick":17,
  "level":"debug", "levelValue":4, "channel":"bullets", "event":"bullet.collide",
  "msg":"…", "data":{ } }
```
`seq` 从 0 递增；`cid`/`tick` 无则 `null`；`msg` 强制字符串（undefined → `''`）。

## 通道语义

- 生效级别 = 通道覆盖（若有）否则全局级别；记录级别数值 ≤ 生效级别才发出。
- **未注册通道**（不在 `CHANNELS`）且记录会发出时 → 在 `log` 通道发 `log.unknownChannels`（warn，**每通道一次**去重）；被过滤掉的记录不触发。
- 环形缓冲溢出：最早记录被丢弃、`dropped` 计数；**每累计 100 次丢弃**在 `log` 通道发 `log.suppressed`（warn，data 含 `dropped`/`ringSize`）。注：§4.7「每 100 tick」的节拍由引擎/调用方决定；本模块的语义为丢弃次数边界（P0-4 实现取向，B11 可调）。

## 注入约定（L11/L12）

参与战斗/生成/AI 执行的公开函数通过 `options.logger` 接收（缺省 `nullLogger`）；`engine` 向下透传；core 内禁止 `require` 本模块或用全局单例。

---

## tests/helpers/log.js 契约（P0-4 冻结，§4.9）

| 导出 | 语义 |
|---|---|
| `createRecordingLogger(opts?)` | `createLogger({level:'all', ringSize: opts.ringSize, now: opts.now})` 的便捷构造 |
| `assertEvent(logger, channel, event, predicate?)` | 存在 ≥1 条匹配记录，否则抛 `AssertionError`；返回匹配记录 |
| `countEvents(logger, event, channel?)` | 统计记录数（`channel` 缺省 = 全部通道） |
| `assertCidChain(logger, cid, events[])` | 按**出现顺序**（子序列，不必连续）找到同 `cid` 的完整事件链，缺链抛错；返回匹配记录 |