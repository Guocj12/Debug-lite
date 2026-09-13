// app.js —— P6 启动（frontend-spec §1.3；F0：日志 + 健康检查；视图/挂载 F2 起）
// ESM 入口：public/index.html 的最后一个 script[module]。boot 可注入（测试覆盖两分支）。
import { log } from './util/log.js';

export function boot(deps) {
  const d = deps || {};
  // fetchImpl = undefined → 取全局 fetch（无则 null）；显式 null/false 也可关闭（测试可达 !f 分支）
  const f = d.fetchImpl === undefined ? (typeof fetch === 'function' ? fetch : null) : d.fetchImpl;
  const lg = d.log || log;
  lg.info('store', 'store.boot', 'P6 bootstrap start', { phase: 'F0' });
  if (!f) {
    lg.warn('store', 'store.boot', 'server unreachable', { message: 'no fetch in env' });
    return Promise.resolve(null);
  }
  return f('/api/v1/health')
    .then((r) => r.json())
    .then((data) => {
      lg.info('store', 'store.boot', 'server ok', { ok: !!data.ok, version: data.data && data.data.version });
      return data;
    })
    .catch((e) => {
      lg.warn('store', 'store.boot', 'server unreachable', { message: e.message });
      return null;
    });
}

boot();