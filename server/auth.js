'use strict';
/* server/auth.js —— 账号与会话（P7-2 / B28；契约 docs/interfaces.md §1 `server/auth.js` + §2 `/auth/*`）
 *
 * 权威：docs/systems/11-account-store.md §4.1（账号状态机）/§4.2（用户名与密码规则 + 失败锁定）
 *      /§4.3（会话 token）/§4.5（对外标识）/§4.6（安全清单）；decisions.md D-129（服务端持久化）
 *
 * 定位：L6——**只做业务规则与结果信封**，一切持久化都走注入的 `server/store` 适配器：
 *   账号创建/改密 = journal `account.created` / `account.password.changed`（D-134，先 journal 再 apply）；
 *   会话 = `store.sessions.*`（`runtime/sessions.json`，只存 sha256(token)，可丢弃）。
 *   本文件**不碰 node:fs**（唯一允许 fs 的目录是 `server/store/*`）。
 *
 * 密码：`node:crypto` 的 scryptSync + 每账号 16 字节随机盐（零依赖）；存储形如
 *   `{ algo:'scrypt', N, r, p, salt(base64), hash(base64), username, usernameLower }`
 *   —— 校验按**档案里记录的算法参数**计算，便于将来升级参数（§4.2）。
 *   注意：`username/usernameLower` 记在 `archive.auth` 内——§5.2 的档案字段全表**没有** username 字段，
 *   而 §4.2 要求"存储保留原大小写、索引键为 lowercase"。详见报告"与设计文档不一致处"。
 *
 * 结果信封：`{ ok, status, code, message, data, details }`（与 server/account.js 同一套，P7-4 直接映射 HTTP）。
 * 日志（通道 `store`，§6 矩阵既有事件，**不新增事件名**）：
 *   store.auth.register(info) / store.auth.login(info) / store.auth.reject(warn) / store.auth.lock(warn)。
 */
const crypto = require('node:crypto');
const { nullLogger } = require('../shared/log.js');
const archiveMod = require('./store/archive.js');
const accountMod = require('./account.js');

const MS_PER_DAY = 86400000;
const TOKEN_BYTES = 32;                                // §4.3：32 随机字节 → base64url（43 字符）
const RENEW_THROTTLE_MS = 60000;                       // 滑动续期的写盘节流（TTL 7 天，60s 粒度无影响）
const DEFAULT_SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, saltBytes: 16, hashBytes: 64 });
const DEFAULT_SESSION = Object.freeze({ ttlDays: 7, maxPerPlayer: 5, maxTotalDays: 30 });

const { ok, fail, detailOf, toFailure } = accountMod;

/* ---------- 纯工具：随机 / 哈希 / 密码 ---------- */

function posInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

// 32 随机字节 → base64url（43 字符，§4.3）
function randomToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

// 服务端只存 sha256(token)（§4.3；明文的唯一出现处是响应体）
function tokenHashOf(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

// IP / UserAgent 只存 sha256 前 16 hex（§12.3）
function hash16(value) {
  if (value === undefined || value === null || value === '') return null;
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 16);
}

// 算法参数（缺省 §4.2：N=16384, r=8, p=1；salt 16B；hash 64B）
function normalizeScrypt(cfg) {
  const c = cfg || {};
  const s = c.scrypt && typeof c.scrypt === 'object' ? c.scrypt : {};
  return {
    N: posInt(s.N, DEFAULT_SCRYPT.N) || DEFAULT_SCRYPT.N,
    r: posInt(s.r, DEFAULT_SCRYPT.r) || DEFAULT_SCRYPT.r,
    p: posInt(s.p, DEFAULT_SCRYPT.p) || DEFAULT_SCRYPT.p,
    saltBytes: posInt(c.saltBytes, DEFAULT_SCRYPT.saltBytes) || DEFAULT_SCRYPT.saltBytes,
    hashBytes: posInt(c.hashBytes, DEFAULT_SCRYPT.hashBytes) || DEFAULT_SCRYPT.hashBytes,
  };
}

// 128*N*r 是 scrypt 的内存需求；给 2 倍余量并保证不低于 node 默认 32MB
function maxmemFor(N, r) {
  return Math.max(32 * 1024 * 1024, 256 * N * r);
}

// 加盐哈希（返回可入档的凭据对象；不含 username —— 调用方补）
function hashPassword(password, cfg) {
  const p = normalizeScrypt(cfg);
  const salt = crypto.randomBytes(p.saltBytes);
  const hash = crypto.scryptSync(Buffer.from(String(password), 'utf8'), salt, p.hashBytes, {
    N: p.N, r: p.r, p: p.p, maxmem: maxmemFor(p.N, p.r),
  });
  return {
    algo: 'scrypt',
    N: p.N,
    r: p.r,
    p: p.p,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
  };
}

// timingSafeEqual（长度不等先补齐再比，避免抛错泄露长度，§4.2）
function timingSafeEqualPadded(a, b) {
  const len = Math.max(a.length, b.length);
  const left = Buffer.alloc(len);
  const right = Buffer.alloc(len);
  a.copy(left);
  b.copy(right);
  return a.length === b.length && crypto.timingSafeEqual(left, right);
}

// 按**存储的算法参数**校验（档案参数可升级，§4.2）；参数非法/数据损坏 → false（不抛）
function verifyPassword(password, stored) {
  if (!stored || stored.algo !== 'scrypt' || typeof stored.salt !== 'string' || typeof stored.hash !== 'string') return false;
  try {
    const salt = Buffer.from(stored.salt, 'base64');
    const expected = Buffer.from(stored.hash, 'base64');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = crypto.scryptSync(Buffer.from(String(password), 'utf8'), salt, expected.length, {
      N: stored.N, r: stored.r, p: stored.p, maxmem: maxmemFor(posInt(stored.N, DEFAULT_SCRYPT.N), posInt(stored.r, DEFAULT_SCRYPT.r)),
    });
    return timingSafeEqualPadded(actual, expected);
  } catch (err) {
    return false;
  }
}

// 密码规则（§4.2：8~72 字符；UTF-8 字节数 ≤ 256）
function validatePassword(password, cfg) {
  const c = cfg || {};
  const min = posInt(c.passwordMin, 8) || 8;
  const max = posInt(c.passwordMax, 72) || 72;
  const maxBytes = posInt(c.passwordMaxBytes, 256) || 256;
  if (typeof password !== 'string') {
    return { ok: false, code: 'weak_password', message: '密码必须是字符串' };
  }
  if (password.length < min || password.length > max) {
    return { ok: false, code: 'weak_password', message: `密码长度需 ${min}~${max} 字符（实际 ${password.length}）` };
  }
  if (Buffer.byteLength(password, 'utf8') > maxBytes) {
    return { ok: false, code: 'weak_password', message: `密码 UTF-8 字节数需 ≤ ${maxBytes}` };
  }
  return { ok: true, code: null, message: null };
}

function validateUsername(username) {
  if (archiveMod.isValidUsername(username)) return { ok: true, code: null, message: null };
  return { ok: false, code: 'bad_request', message: '用户名需 3~24 字符，且只含 [A-Za-z0-9_-]' };
}

// 反用户名枚举的时间对齐：账号不存在时也做一次等价 scrypt（§4.6 统一错误码的补充）
const DUMMY_SALT = Buffer.alloc(DEFAULT_SCRYPT.saltBytes).toString('base64');
const DUMMY_HASH = Buffer.alloc(DEFAULT_SCRYPT.hashBytes).toString('base64');

/* ---------- 登录失败限速与锁定（§4.2） ---------- */

/**
 * createFailureLimiter({ config, now? })
 *   config：service-config.json 的 auth 段（maxFailures/lockMinutes/rateLimitPerMinute）
 * 语义：
 *   · 同一用户名连续失败 maxFailures 次 → 锁 lockMinutes 分钟（第 N 次失败本身仍返回
 *     invalid_credentials，锁生效后**下一次**尝试返回 too_many_attempts）；锁过期 → 计数清零。
 *   · 同一 IP 每分钟 > rateLimitPerMinute 次尝试 → too_many_attempts（滑动窗口）。
 * 存储：进程内（不落盘）——与 `runtime/sessions.json`（可丢弃）同级的临时风控状态。
 */
function createFailureLimiter(options) {
  const o = options || {};
  const cfg = o.config || {};
  const nowFn = typeof o.now === 'function' ? o.now : () => Date.now();
  const maxFailures = posInt(cfg.maxFailures, 5) || 5;
  const lockMs = (posInt(cfg.lockMinutes, 5) || 5) * 60000;
  const rateLimit = posInt(cfg.rateLimitPerMinute, 10) || 10;
  const windowMs = Number.isInteger(cfg.rateWindowMs) && cfg.rateWindowMs > 0 ? cfg.rateWindowMs : 60000;
  const failures = new Map();  // usernameLower → { count, lockedUntil }
  const attempts = new Map();  // ipKey → number[]（窗口内时间戳）

  function keyOf(value) {
    return typeof value === 'string' && value !== '' ? value.toLowerCase() : null;
  }

  function pruneAttempts(ipKey, now) {
    if (ipKey === null) return [];
    const hits = (attempts.get(ipKey) || []).filter((t) => now - t < windowMs);
    attempts.set(ipKey, hits);
    return hits;
  }

  function lockState(userKey, now) {
    if (userKey === null) return null;
    const rec = failures.get(userKey);
    if (!rec) return null;
    if (rec.lockedUntil > now) return rec;
    failures.delete(userKey); // 锁已过期 → 连续失败计数清零
    return null;
  }

  // 尝试入口：先查 IP 限速，再查用户名锁定；通过则记一次尝试
  function begin(input) {
    const i = input || {};
    const now = nowFn();
    const ipKey = keyOf(i.ip);
    const hits = pruneAttempts(ipKey, now);
    if (ipKey !== null && hits.length >= rateLimit) {
      return {
        ok: false, code: 'too_many_attempts', reason: 'ip_rate_limited',
        message: `同一 IP 每分钟最多 ${rateLimit} 次尝试`,
        retryAfterMs: Math.max(0, windowMs - (now - hits[0])),
      };
    }
    const userKey = keyOf(i.usernameLower);
    const locked = lockState(userKey, now);
    if (locked) {
      return {
        ok: false, code: 'too_many_attempts', reason: 'username_locked',
        message: `连续失败 ${maxFailures} 次，账号已锁定至 ${new Date(locked.lockedUntil).toISOString()}`,
        retryAfterMs: locked.lockedUntil - now,
        lockedUntil: locked.lockedUntil,
      };
    }
    if (ipKey !== null) {
      hits.push(now);
      attempts.set(ipKey, hits);
    }
    return { ok: true, code: null, reason: null };
  }

  // 记一次失败；返回 {locked} 表示本次是否触发锁定
  function failure(input) {
    const i = input || {};
    const now = nowFn();
    const userKey = keyOf(i.usernameLower);
    if (userKey === null) return { locked: false, failures: 0, lockedUntil: null, threshold: maxFailures };
    const rec = failures.get(userKey) || { count: 0, lockedUntil: 0 };
    rec.count += 1;
    let locked = false;
    if (rec.count >= maxFailures) {
      rec.lockedUntil = now + lockMs;
      rec.count = 0;
      locked = true;
    }
    failures.set(userKey, rec);
    return { locked, failures: rec.count, lockedUntil: rec.lockedUntil, threshold: maxFailures, lockMs };
  }

  function success(input) {
    const userKey = keyOf((input || {}).usernameLower);
    if (userKey !== null) failures.delete(userKey);
  }

  return {
    begin,
    failure,
    success,
    maxFailures,
    lockMs,
    rateLimit,
    windowMs,
    // 诊断 / 测试
    lockedUntil: (usernameLower) => {
      const rec = failures.get(keyOf(usernameLower));
      return rec && rec.lockedUntil > nowFn() ? rec.lockedUntil : null;
    },
    reset: () => { failures.clear(); attempts.clear(); },
    stats: () => ({ locked: failures.size, ips: attempts.size, maxFailures, lockMs, rateLimit, windowMs }),
  };
}

/* ---------- 门面工厂 ---------- */

function resolveAuthConfig(storeCfg, overrideCfg) {
  const base = (storeCfg && storeCfg.auth) || {};
  const o = overrideCfg || {};
  const nested = o.auth && typeof o.auth === 'object' ? o.auth : {};
  const flat = {};
  for (const key of Object.keys(o)) {
    if (key !== 'auth' && key !== 'session') flat[key] = o[key];
  }
  return { ...base, ...flat, ...nested };
}

function resolveSessionConfig(storeCfg, overrideCfg) {
  const base = (storeCfg && storeCfg.session) || {};
  const nested = overrideCfg && overrideCfg.session && typeof overrideCfg.session === 'object' ? overrideCfg.session : {};
  const merged = { ...DEFAULT_SESSION, ...base, ...nested };
  return {
    ttlDays: posInt(merged.ttlDays, DEFAULT_SESSION.ttlDays) || DEFAULT_SESSION.ttlDays,
    maxPerPlayer: posInt(merged.maxPerPlayer, DEFAULT_SESSION.maxPerPlayer) || DEFAULT_SESSION.maxPerPlayer,
    maxTotalDays: posInt(merged.maxTotalDays, DEFAULT_SESSION.maxTotalDays) || DEFAULT_SESSION.maxTotalDays,
  };
}

function playerBrief(archive) {
  const active = archiveMod.activeSlot(archive);
  return {
    publicId: archive.publicId,
    nickname: archive.nickname,
    tier: archive.progress.tier,
    points: archive.rating.points,
    activeSlotId: archive.configs.activeSlotId,
    activeSlotName: active ? active.name : null,
    activeSnapshotHash: archive.configs.activeSnapshotHash,
    slots: (archive.configs.slots || []).map((s) => ({ slotId: s.slotId, name: s.name, isDefault: !!s.isDefault })),
  };
}

function sessionView(rec, renewed) {
  const expiresAt = renewed && renewed.expiresAt !== undefined ? renewed.expiresAt : rec.expiresAt;
  const lastUsedAt = renewed && renewed.lastUsedAt !== undefined ? renewed.lastUsedAt : rec.lastUsedAt;
  return { createdAt: rec.createdAt, lastUsedAt: lastUsedAt === undefined ? null : lastUsedAt, expiresAt: expiresAt === undefined ? null : expiresAt };
}

/**
 * createAuth({ store, account?, logger?, now?, config? })
 *   store   必填（server/store 适配器，已 open）
 *   account 可选（account 门面；缺省按 store 自建——注册事务经它下发默认配置，§5.3）
 *   config  可选覆盖：`{ auth:{…}, session:{…} }`，或扁平键（maxFailures/scrypt/…）
 * 返回对象的方法全部 async，一律返回结果信封（不抛异常）。
 */
function createAuth(options) {
  const opts = options || {};
  const store = opts.store;
  if (!store || typeof store.loadArchive !== 'function' || typeof store.sessions !== 'object') {
    throw new TypeError('createAuth 需要已装配的 store 适配器（server/store/index.js createStore/openStore）');
  }
  const log = opts.logger || nullLogger;
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const account = opts.account || accountMod.createAccount({ store, logger: log, now: nowFn });
  const authCfg = resolveAuthConfig(store.config, opts.config);
  const sessionCfg = resolveSessionConfig(store.config, opts.config);
  const scryptCfg = normalizeScrypt(authCfg);
  const limiter = createFailureLimiter({ config: authCfg, now: nowFn });
  const usernameIndex = new Map(); // lowercase → playerId
  let usernameIndexBuilt = false;

  function logReject(op, data) {
    log.warn('store', 'store.auth.reject', `鉴权拒绝（${op}）`, Object.assign({ op }, data || {}));
  }

  /* ---------- 用户名索引（大小写不敏感唯一，§4.2） ---------- */

  // 惰性重建：扫描 players/*（archive.auth.usernameLower）。store 的 index.json 不含 username，
  // 故冷启动首次注册/登录需扫描一次；运行期由 register 增量维护。
  async function ensureUsernameIndex() {
    if (usernameIndexBuilt) return usernameIndex;
    usernameIndex.clear();
    const ids = store.listPlayerIds();
    for (const playerId of ids) {
      const archive = await store.loadArchive(playerId);
      const lower = archive && archive.auth && archive.auth.usernameLower;
      if (typeof lower === 'string' && lower !== '') usernameIndex.set(lower, playerId);
    }
    usernameIndexBuilt = true;
    log.debug('store', 'store.read', `用户名索引已建立（${usernameIndex.size} 条）`, { accounts: usernameIndex.size });
    return usernameIndex;
  }

  /* ---------- 会话（§4.3） ---------- */

  function issueToken(input) {
    const token = randomToken();
    const tokenHash = tokenHashOf(token);
    const createdAt = nowFn();
    const expiresAt = createdAt + sessionCfg.ttlDays * MS_PER_DAY;
    store.sessions.put({
      tokenHash,
      playerId: input.playerId,
      createdAt,
      expiresAt,
      lastUsedAt: createdAt,
      userAgentHash: hash16(input.userAgent),
      ipHash: hash16(input.ip),
    });
    return { token, tokenHash, createdAt, expiresAt };
  }

  // 滑动续期（§4.3：最多延长到 createdAt + maxTotalDays；写盘节流 60s）
  function renewPatch(rec) {
    const now = nowFn();
    const created = Number.isInteger(rec.createdAt) ? rec.createdAt : now;
    const nextExpiresAt = Math.min(now + sessionCfg.ttlDays * MS_PER_DAY, created + sessionCfg.maxTotalDays * MS_PER_DAY);
    const prev = Number.isInteger(rec.expiresAt) ? rec.expiresAt : 0;
    if (nextExpiresAt <= prev) return null;
    const lastUsed = Number.isInteger(rec.lastUsedAt) ? rec.lastUsedAt : 0;
    if (now - lastUsed < RENEW_THROTTLE_MS) return null;
    return { lastUsedAt: now, expiresAt: nextExpiresAt };
  }

  function tokenOf(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input === 'object' && typeof input.token === 'string') return input.token;
    return null;
  }

  /* ---------- 对外方法 ---------- */

  // POST /auth/register：注册 + 下发默认配置 + 发 token（§4.1/§5.3）
  async function register(input) {
    const o = input || {};
    try {
      const username = o.username;
      const usernameCheck = validateUsername(username);
      const pwCheck = validatePassword(o.password, authCfg);
      const nickname = o.nickname === undefined || o.nickname === null ? username : o.nickname;
      const lower = typeof username === 'string' ? username.toLowerCase() : null;
      const gate = limiter.begin({ ip: o.ip, usernameLower: lower });
      if (!gate.ok) {
        log.warn('store', 'store.auth.lock', `注册被限速：${gate.message}`, { reason: gate.reason, retryAfterMs: gate.retryAfterMs });
        return fail('too_many_attempts', gate.message);
      }
      if (!usernameCheck.ok) {
        return fail('bad_request', usernameCheck.message, [detailOf('bad_request', usernameCheck.message, 'username')]);
      }
      if (!archiveMod.isValidNickname(nickname)) {
        return fail('bad_request', '昵称需 1~16 字符', [detailOf('bad_request', '非法昵称', 'nickname')]);
      }
      if (!pwCheck.ok) {
        return fail('weak_password', pwCheck.message, [detailOf('weak_password', pwCheck.message, 'password')]);
      }
      await ensureUsernameIndex();
      if (usernameIndex.has(lower)) {
        logReject('register', { reason: 'username_taken' });
        return fail('username_taken', '用户名已被占用（大小写不敏感）', [detailOf('username_taken', '用户名已存在', 'username')]);
      }
      const auth = Object.assign(hashPassword(o.password, authCfg), { username, usernameLower: lower });
      const created = await account.createPlayerArchive({
        playerId: o.playerId,
        publicId: o.publicId,
        nickname,
        auth,
        warehouse: o.warehouse,
        tier: o.tier,
        at: nowFn(),
      });
      if (!created.ok) return created;
      const archive = created.data.archive;
      usernameIndex.set(lower, archive.playerId);
      const token = issueToken({ playerId: archive.playerId, ip: o.ip, userAgent: o.userAgent });
      log.info('store', 'store.auth.register', `注册成功 ${archive.publicId}`, {
        publicId: archive.publicId, tier: archive.progress.tier, points: archive.rating.points,
      });
      return ok({
        playerId: archive.playerId, // 仅服务端内部使用（§4.5）；P7-4 不得回带客户端
        publicId: archive.publicId,
        nickname: archive.nickname,
        token: token.token,
        expiresAt: token.expiresAt,
        player: playerBrief(archive),
      });
    } catch (err) {
      return toFailure(err, log, 'register');
    }
  }

  // POST /auth/login：密码校验 + 失败限速 + 发 token（§4.2/§4.3）
  async function login(input) {
    const o = input || {};
    try {
      const username = o.username;
      const lower = typeof username === 'string' ? username.toLowerCase() : null;
      const gate = limiter.begin({ ip: o.ip, usernameLower: lower });
      if (!gate.ok) {
        log.warn('store', 'store.auth.lock', `登录被限速：${gate.message}`, { reason: gate.reason, retryAfterMs: gate.retryAfterMs });
        return fail('too_many_attempts', gate.message);
      }
      if (!archiveMod.isValidUsername(username) || typeof o.password !== 'string' || o.password === '') {
        // 统一 invalid_credentials（不区分"用户不存在/密码错误/参数形状"，§4.6）
        limiter.failure({ usernameLower: lower });
        logReject('login', { reason: 'invalid_credentials' });
        return fail('invalid_credentials', '用户名或密码错误');
      }
      await ensureUsernameIndex();
      const playerId = usernameIndex.get(lower);
      const archive = playerId ? await store.loadArchive(playerId) : null;
      let passwordOk = false;
      if (archive) {
        passwordOk = verifyPassword(o.password, archive.auth);
      } else {
        // 时间对齐（反枚举）：账号不存在时做一次等价 scrypt
        verifyPassword(o.password, { algo: 'scrypt', N: scryptCfg.N, r: scryptCfg.r, p: scryptCfg.p, salt: DUMMY_SALT, hash: DUMMY_HASH });
      }
      if (!passwordOk) {
        const res = limiter.failure({ usernameLower: lower });
        if (res.locked) {
          log.warn('store', 'store.auth.lock', `连续失败 ${res.threshold} 次，账号锁定 ${res.lockMs / 60000} 分钟`, {
            publicId: archive ? archive.publicId : null, failures: res.threshold, lockedUntil: res.lockedUntil,
          });
        }
        logReject('login', { publicId: archive ? archive.publicId : null, reason: 'invalid_credentials' });
        return fail('invalid_credentials', '用户名或密码错误');
      }
      if (archive.flags.banned) {
        limiter.success({ usernameLower: lower });
        logReject('login', { publicId: archive.publicId, reason: 'banned' });
        return fail('banned', '账号已被封禁');
      }
      limiter.success({ usernameLower: lower });
      const loggedIn = (await store.touchLastSeen(archive.playerId, nowFn())) || archive;
      const token = issueToken({ playerId: archive.playerId, ip: o.ip, userAgent: o.userAgent });
      log.info('store', 'store.auth.login', `登录成功 ${archive.publicId}`, {
        publicId: archive.publicId, tier: loggedIn.progress.tier, points: loggedIn.rating.points,
      });
      return ok({
        playerId: archive.playerId, // 仅服务端内部使用（§4.5）
        publicId: loggedIn.publicId,
        nickname: loggedIn.nickname,
        token: token.token,
        expiresAt: token.expiresAt,
        player: playerBrief(loggedIn),
      });
    } catch (err) {
      return toFailure(err, log, 'login');
    }
  }

  // POST /auth/logout：撤销当前会话（其他设备不受影响，§4.1）
  async function logout(input) {
    try {
      const token = tokenOf(input);
      if (!token) return fail('unauthorized', '缺少会话 token');
      const tokenHash = tokenHashOf(token);
      const rec = store.sessions.get(tokenHash);
      if (!rec) {
        logReject('logout', { reason: 'unauthorized' });
        return fail('unauthorized', '会话不存在或已过期');
      }
      store.sessions.revoke(tokenHash);
      log.debug('store', 'store.write', 'auth.logout', { op: 'logout', publicId: null });
      return ok({ revoked: true, playerId: rec.playerId });
    } catch (err) {
      return toFailure(err, log, 'logout');
    }
  }

  // POST /auth/password：改密 + 撤销除当前外全部会话（§4.1）
  async function changePassword(input) {
    const o = input || {};
    try {
      const token = tokenOf(o);
      if (!token) return fail('unauthorized', '缺少会话 token');
      const tokenHash = tokenHashOf(token);
      const rec = store.sessions.get(tokenHash);
      if (!rec) {
        logReject('changePassword', { reason: 'unauthorized' });
        return fail('unauthorized', '会话不存在或已过期');
      }
      if (o.playerId !== undefined && o.playerId !== null && o.playerId !== rec.playerId) {
        logReject('changePassword', { reason: 'forbidden', playerId: o.playerId });
        return fail('forbidden', '不能修改其他账号的密码');
      }
      const archive = await store.loadArchive(rec.playerId);
      if (!archive) {
        store.sessions.revoke(tokenHash);
        return fail('unauthorized', '会话对应的档案不存在');
      }
      const pwCheck = validatePassword(o.newPassword, authCfg);
      if (!pwCheck.ok) {
        return fail('weak_password', pwCheck.message, [detailOf('weak_password', pwCheck.message, 'newPassword')]);
      }
      if (!verifyPassword(o.oldPassword, archive.auth)) {
        limiter.failure({ usernameLower: (archive.auth && archive.auth.usernameLower) || null });
        logReject('changePassword', { publicId: archive.publicId, reason: 'invalid_credentials' });
        return fail('invalid_credentials', '原密码错误');
      }
      const auth = Object.assign(hashPassword(o.newPassword, authCfg), {
        username: archive.auth && archive.auth.username !== undefined ? archive.auth.username : null,
        usernameLower: archive.auth && archive.auth.usernameLower !== undefined ? archive.auth.usernameLower : null,
      });
      await store.setPasswordHash({ playerId: archive.playerId, auth });
      const revoked = store.sessions.revokePlayer(archive.playerId, { keepTokenHash: tokenHash });
      limiter.success({ usernameLower: auth.usernameLower });
      log.debug('store', 'store.write', `auth.password.changed（撤销其他会话 ${revoked.revoked} 个）`, {
        op: 'password.changed', publicId: archive.publicId, revokedOthers: revoked.revoked,
      });
      return ok({ changed: true, revokedOthers: revoked.revoked, keepSession: true });
    } catch (err) {
      return toFailure(err, log, 'changePassword');
    }
  }

  // 鉴权（§4.4）：token → ctx.player（P7-4 中间件调用；**不要**把 playerId 回带客户端）
  async function authenticate(token) {
    try {
      const value = tokenOf(token);
      if (!value) {
        logReject('authenticate', { reason: 'unauthorized' });
        return fail('unauthorized', '缺少会话 token');
      }
      const tokenHash = tokenHashOf(value);
      const rec = store.sessions.get(tokenHash);
      if (!rec) {
        logReject('authenticate', { reason: 'unauthorized' });
        return fail('unauthorized', '会话无效或已过期');
      }
      const archive = await store.loadArchive(rec.playerId);
      if (!archive) {
        store.sessions.revoke(tokenHash);
        logReject('authenticate', { reason: 'unauthorized', playerId: rec.playerId });
        return fail('unauthorized', '会话对应的档案不存在');
      }
      if (archive.flags.banned) {
        logReject('authenticate', { publicId: archive.publicId, reason: 'banned' });
        return fail('banned', '账号已被封禁');
      }
      const patch = renewPatch(rec);
      if (patch) store.sessions.touch(tokenHash, patch);
      return ok({
        playerId: rec.playerId, // 仅服务端内部（§4.5）
        publicId: archive.publicId,
        nickname: archive.nickname,
        isBot: !!archive.flags.isBot,
        session: sessionView(rec, patch),
        // §4.4 步骤 4：P7-4 直接把它作为 ctx.player 注入
        player: { playerId: rec.playerId, ...playerBrief(archive) },
      });
    } catch (err) {
      return toFailure(err, log, 'authenticate');
    }
  }

  // 「我的登录设备」列表（§4.3 记录的用途；**不返回** token 明文或 tokenHash）
  async function listSessions(playerId) {
    try {
      if (typeof playerId !== 'string' || playerId === '') {
        return fail('bad_request', '需要 playerId', [detailOf('bad_request', '非法 playerId', 'playerId')]);
      }
      const list = store.sessions.list(playerId).map((rec) => ({
        createdAt: rec.createdAt,
        lastUsedAt: rec.lastUsedAt === undefined ? null : rec.lastUsedAt,
        expiresAt: rec.expiresAt === undefined ? null : rec.expiresAt,
        ipHash: rec.ipHash === undefined ? null : rec.ipHash,
        userAgentHash: rec.userAgentHash === undefined ? null : rec.userAgentHash,
      }));
      return ok({ sessions: list, count: list.length, maxPerPlayer: sessionCfg.maxPerPlayer });
    } catch (err) {
      return toFailure(err, log, 'listSessions');
    }
  }

  // 撤销某玩家全部会话（改密/封禁之外的运维入口；store.setBanned 内部亦会撤销）
  async function revokeAllSessions(playerId) {
    try {
      if (typeof playerId !== 'string' || playerId === '') {
        return fail('bad_request', '需要 playerId', [detailOf('bad_request', '非法 playerId', 'playerId')]);
      }
      const res = store.sessions.revokePlayer(playerId);
      log.debug('store', 'store.write', `auth.sessions.revoked（${res.revoked} 个）`, { op: 'sessions.revoked', revoked: res.revoked });
      return ok(res);
    } catch (err) {
      return toFailure(err, log, 'revokeAllSessions');
    }
  }

  return {
    store,
    account,
    config: { auth: authCfg, session: sessionCfg, scrypt: scryptCfg },
    limiter,
    // §4.1 状态机
    register,
    login,
    logout,
    changePassword,
    authenticate,
    // 会话视图/运维
    listSessions,
    revokeAllSessions,
    // 测试/诊断
    ensureUsernameIndex,
    usernameIndexOf: (username) => (typeof username === 'string' ? usernameIndex.get(username.toLowerCase()) || null : null),
  };
}

module.exports = {
  createAuth,
  createFailureLimiter,
  hashPassword,
  verifyPassword,
  validatePassword,
  validateUsername,
  randomToken,
  tokenHashOf,
  hash16,
  normalizeScrypt,
  maxmemFor,
  DEFAULT_SCRYPT,
  DEFAULT_SESSION,
  RENEW_THROTTLE_MS,
  TOKEN_BYTES,
  MS_PER_DAY,
};
