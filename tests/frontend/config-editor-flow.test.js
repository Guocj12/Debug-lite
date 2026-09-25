'use strict';
/* tests/frontend/config-editor-flow.test.js —— F3 提交③（出战配置编辑器）真实 HTTP 全流程 + 机器核对
 *
 * 权威：docs/frontend/03-hub-warehouse-loadout.md §3.7（逐位置显示规则 + **⚠️ 两步顺序**）、§3.8（弹窗通用规则）、
 *   §4（9 个新动作）、§5（字段来源）、§6（全部失败路径）、§8（B-4…B-10）、§10（UW-2/UW-3/UW-4）、§11（走查步 10–21）。
 * 与浏览器完全同构：public/{store,format,render,actions,api,app}.js，baseUrl 指向**进程内起真实服务**。
 *
 * 覆盖：
 *   CF-1  打开编辑器：5 类位置 / 插槽按实际数量与类型 / `空` 可点 / 草稿 = 服务端副本 / 状态行
 *   CF-2  三个候选弹窗：slot-pick（仓库同分类 + `空`）· plugin-pick（**全部列出**，不匹配标灰 + 原因）· ai-pick（库条目）
 *   CF-3  **两步顺序**（本批最容易错的一条）：装配 → 草稿用响应回带的更新物品 → 保存后 GET /me/configs 引用真的变了
 *   CF-4  出战中的配置：模板候选无 `空`；插件可「清空此槽」；把角色/技能置空 → 409 → 可读文案（B-5）
 *   CF-5  配置2 从全空开始逐位置装配 → 保存 → 设为出战 200 → 主界面/仓库标记同步
 *   CF-6  设为出战不完整 → 409 cannot_activate_incomplete → 逐位置文案；有未保存修改时先要求保存
 *   CF-7  点弹窗外 → 关闭 + 丢弃草稿（再打开是原状）（B-9）
 *   CF-8  契约：新增槽级/AI 条目字段三方一致（contract == 分册 §5 == format 实读）+ 真实响应可解析
 *   CF-9  DOM 装配层：data-pos / data-idx / data-empty / data-ai-id → payload → 动作（含两步顺序）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, playerIdByPublicId } = require('../helpers/http.js');
const store = require('../../public/store.js');
const format = require('../../public/format.js');
const render = require('../../public/render.js');
const actions = require('../../public/actions.js');
const apiMod = require('../../public/api.js');
const appMod = require('../../public/app.js');
const contract = require('../../public/contract.js');

const REPO = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(REPO, 'public');
const DOC3 = path.join(REPO, 'docs', 'frontend', '03-hub-warehouse-loadout.md');
const PW1 = 'pw12345678';

function fakeWin() {
  const map = new Map();
  return {
    map,
    localStorage: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    },
  };
}

// 与 public/app.js 的 buildCtx/run 同形；api 出口逐个计数并记录请求体（用于"两步顺序"断言）
function harness(baseUrl) {
  const win = fakeWin();
  const st = store.createStore(store.initialState());
  const storage = appMod.createStorage(win);
  const raw = apiMod.createApi({ baseUrl });
  const counter = { n: 0 };
  const assembleCalls = [];
  const disassembleCalls = [];
  const saveCalls = [];
  const activateCalls = [];
  const counting = (fn) => (...a) => { counter.n += 1; return fn(...a); };
  const api = {
    call: counting(raw.call),
    register: counting(raw.register),
    login: counting(raw.login),
    logout: counting(raw.logout),
    changePassword: counting(raw.changePassword),
    me: counting(raw.me),
    warehouse: counting(raw.warehouse),
    box: counting(raw.box),
    configs: counting(raw.configs),
    aiList: counting(raw.aiList),
    setNickname: counting(raw.setNickname),
    admin: counting(raw.admin),
    assemble: (token, input) => { counter.n += 1; assembleCalls.push(input); return raw.assemble(token, input); },
    disassemble: (token, input) => { counter.n += 1; disassembleCalls.push(input); return raw.disassemble(token, input); },
    saveConfig: (token, slotId, input) => {
      counter.n += 1; saveCalls.push({ slotId, loadout: input.loadout });
      return raw.saveConfig(token, slotId, input);
    },
    activateConfig: (token, slotId) => { counter.n += 1; activateCalls.push(slotId); return raw.activateConfig(token, slotId); },
  };
  const h = {
    win, storage, api, counter, assembleCalls, disassembleCalls, saveCalls, activateCalls,
    state: () => st.getState(),
    dispatch: (a) => st.dispatch(a),
    html: () => render.render(format.viewModel(st.getState())),
    notice: () => (st.getState().notice ? st.getState().notice.text : ''),
    form: (values) => { for (const [k, v] of Object.entries(values)) st.dispatch({ type: 'form.set', field: k, value: v }); },
    run: (name, payload) => {
      const ctx = { state: st.getState(), dispatch: (a) => st.dispatch(a), api, format, storage, actions: actions.ACTIONS };
      return Promise.resolve(actions.ACTIONS[name].run(ctx, payload || null));
    },
    signUp: async (username) => {
      h.form({ username, password: PW1, confirm: PW1 });
      await h.run('submit-register');
      assert.equal(h.state().view, 'hub', '注册后应落在主界面（FR-11）');
      return h.state().profile;
    },
    // **独立于前端状态**地向服务端要配置列表（用于校验"保存后引用真的变了"）
    fetchConfigs: async () => {
      const token = h.state().session.token;
      assert.ok(token, '需要已登录会话');
      const r = await raw.configs(token);
      assert.equal(r.transport, 'response', '配置列表取数应成功');
      assert.equal(format.isOk(r.envelope), true, JSON.stringify(r.envelope));
      return r.envelope;
    },
    fetchWarehouse: async () => {
      const r = await raw.warehouse(h.state().session.token);
      assert.equal(format.isOk(r.envelope), true, JSON.stringify(r.envelope));
      return r.envelope;
    },
    slotOf: async (slotId) => {
      const env = await h.fetchConfigs();
      const slot = env.data.slots.find((s) => s.slotId === slotId);
      assert.ok(slot, `服务端应有配置槽 ${slotId}`);
      return slot;
    },
    // 直接读服务端仓库里的某件物品（绕过前端状态）
    itemOf: async (uid) => {
      const env = await h.fetchWarehouse();
      for (const bucket of format.BUCKET_ORDER) {
        const found = format.bucketItems(env, bucket).find((i) => i.uid === uid);
        if (found) return found;
      }
      return null;
    },
  };
  return h;
}

async function withHarness(fn) {
  const s = await startServer({ prefix: 'dl-fe-cfg-', level: 'warn' });
  try {
    return await fn(harness(s.baseUrl), s);
  } finally {
    await s.cleanup();
  }
}

/* ---------- 确定性夹具（starter 的插件已装在原插槽上，不能保证还有空位） ---------- */

// D-163（2026-09-25 用户裁定：一件物品同时只能被一份配置引用）：配置2 必须用**它自己**那一套物品 ——
//   slot1 是 starter 出战配置，它引用的角色/技能已被"占用"，配置2 再引用同一件会被 409 item_in_use 拦下。
//   故夹具备 1 个角色 + 3 个技能（全是注入的独立 uid，与 starter 的物品互不相同）。
const FIX = {
  role: 'fce_role', skills: ['fce_skill0', 'fce_skill1', 'fce_skill2'],
  atkPlugin: 'fce_plugin_atk', atkPlugin2: 'fce_plugin_atk2', defPlugin: 'fce_plugin_def',
  skillPlugin: 'fce_plugin_basic', skillPluginOther: 'fce_plugin_special',
};

async function injectFixture(s, playerId) {
  assert.ok(playerId, '应能用 publicId 反查到 playerId');
  await s.store.updateArchive(playerId, (a) => {
    a.warehouse.buckets.role.push({
      uid: FIX.role, kind: 'role', templateId: 'role_bal', name: '夹具角色', quality: 'rare',
      slotCount: 2, slots: [{ type: 'atk', pluginUid: null }, { type: 'def', pluginUid: null }],
      stats: { hp: 120, atk: 12, def: 9, sp: 60, mp: 40 }, regen: { mp: 1, sp: 2 },
      unlockTier: 'common', pluginPoints: 3,
    });
    a.warehouse.buckets.skill.push({
      uid: FIX.skills[0], kind: 'skill', templateId: 'skill_melee_whirl', name: '夹具技能1', quality: 'rare',
      slotCount: 1, slots: [{ type: 'basic', pluginUid: null }],
      params: { multiplier: 1, cost: { hp: 0, mp: 0, sp: 10 }, cooldown: 2, bulletLevel: 2 },
      unlockTier: 'common',
    });
    a.warehouse.buckets.skill.push({
      uid: FIX.skills[1], kind: 'skill', templateId: 'skill_melee_whirl', name: '夹具技能2', quality: 'rare',
      slotCount: 1, slots: [{ type: 'basic', pluginUid: null }],
      params: { multiplier: 1, cost: { hp: 0, mp: 0, sp: 10 }, cooldown: 2, bulletLevel: 2 },
      unlockTier: 'common',
    });
    a.warehouse.buckets.skill.push({
      uid: FIX.skills[2], kind: 'skill', templateId: 'skill_melee_whirl', name: '夹具技能3', quality: 'rare',
      slotCount: 1, slots: [{ type: 'basic', pluginUid: null }],
      params: { multiplier: 1, cost: { hp: 0, mp: 0, sp: 10 }, cooldown: 2, bulletLevel: 2 },
      unlockTier: 'common',
    });
    a.warehouse.buckets.rolePlugin.push({
      uid: FIX.atkPlugin, kind: 'rolePlugin', id: 'rp_atk_flat', name: '攻击 +4', slot: 'atk',
      category: '攻击提升', quality: 'common', tier: 1, affixes: [], unlockTier: 'common', pointCost: 1,
    });
    a.warehouse.buckets.rolePlugin.push({
      uid: FIX.defPlugin, kind: 'rolePlugin', id: 'rp_def_flat', name: '防御 +3', slot: 'def',
      category: '防御强化', quality: 'common', tier: 1, affixes: [], unlockTier: 'common', pointCost: 1,
    });
    a.warehouse.buckets.rolePlugin.push({
      uid: FIX.atkPlugin2, kind: 'rolePlugin', id: 'rp_atk_pct', name: '攻击 +8%', slot: 'atk',
      category: '攻击提升', quality: 'common', tier: 1, affixes: [], unlockTier: 'common', pointCost: 1,
    });
    a.warehouse.buckets.skillPlugin.push({
      uid: FIX.skillPlugin, kind: 'skillPlugin', id: 'sp_mult', name: '倍率 +10%', slot: 'basic',
      category: '倍率提升', quality: 'common', tier: 1, affixes: [], unlockTier: 'common', costDeltaByTier: { sp: [2, 4, 6] },
    });
    a.warehouse.buckets.skillPlugin.push({
      uid: FIX.skillPluginOther, kind: 'skillPlugin', id: 'sp_crit', name: '暴击 +5%', slot: 'special',
      category: '暴击提升', quality: 'common', tier: 1, affixes: [], unlockTier: 'common', costDeltaByTier: { sp: [2, 4, 6] },
    });
    return null;
  });
}

async function withFixture(fn, username) {
  return withHarness(async (h, s) => {
    const me = await h.signUp(username);
    await injectFixture(s, await playerIdByPublicId(s.store, me.data.publicId));
    return fn(h, s, me);
  });
}

/* ---------- 小工具 ---------- */

const buttonTags = (html) => [...html.matchAll(/<button[^>]*>[^<]*<\/button>/g)].map((m) => m[0]);
const tagsWith = (html, fragment) => buttonTags(html).filter((t) => t.includes(fragment));
const labelsOf = (html) => buttonTags(html).map((t) => t.replace(/^.*>/, '').replace(/<\/button>$/, ''));

// 把一个位置填成"可用的物品"（角色/技能都从**注入夹具**里挑 —— 确定性且不与 slot1 的 starter 物品撞车）。
// D-163（2026-09-25 用户裁定：一件物品同时只能被一份配置引用）：不能退化成"仓库里第一个角色/技能"，
//   那正是 starter 已出战引用过的物品，保存时会被服务端 409 item_in_use 拦下。
async function fillSlot(h, slotId, opts) {
  const whEnv = h.state().warehouse.envelope;
  const o = opts || {};
  const roleUid = o.roleUid || FIX.role;
  const skillUids = o.skillUids || FIX.skills;
  const roles = format.bucketItems(whEnv, 'role');
  const skills = format.bucketItems(whEnv, 'skill');
  assert.ok(roles.some((i) => i.uid === roleUid), `仓库里应有注入夹具角色 ${roleUid}`);
  await h.run('slot-set', { slot: slotId, pos: 'role', uid: roleUid });
  for (let k = 0; k < 3; k += 1) {
    const uid = skillUids[k];
    assert.ok(skills.some((i) => i.uid === uid), `仓库里应有注入夹具技能 ${uid}`);
    await h.run('slot-set', { slot: slotId, pos: 'skill' + k, uid });
  }
  const aiItems = format.aiCandidatesOf(h.state().configs.ai);
  const aiId = o.aiId || (aiItems[0] && aiItems[0].aiId);
  assert.ok(aiId, 'AI 库应至少有一条（starter 注册即发）');
  await h.run('ai-set', { slot: slotId, aiId });
  return { roleUid, aiId };
}

/* ---------- CF-1：打开编辑器 ---------- */

test('CF-1 打开编辑器：5 类位置 / 插槽按实际数量与类型 / `空` 可点 / 草稿 = 服务端副本', async () => {
  await withHarness(async (h) => {
    await h.signUp('cfe1user');
    const before = h.counter.n;
    await h.run('config-open', { slot: 'slot1' });
    // 编辑器要同时显示：配置正文 + 仓库候选（模板/插件名）+ AI 库（AI 位置的**名字**）→ 三次静默取数
    assert.equal(h.counter.n, before + 3, '打开编辑器应取 configs + warehouse + ai 三份数据');
    assert.equal(h.notice(), '', '打开编辑器的取数是静默的（失败才可见）');
    assert.deepEqual(h.state().modal, { kind: 'config', slotId: 'slot1' });
    assert.equal(h.state().configs.dirty, false, '刚打开的草稿未修改');

    const slot = await h.slotOf('slot1');
    assert.deepEqual(h.state().configs.draft.loadout, slot.loadout, '草稿必须是服务端副本（逐值相等）');

    const html = h.html();
    assert.ok(html.includes('id="modal"'), '编辑器是屏内区块（不是浏览器原生弹窗）');
    assert.ok(html.includes('data-action="modal-close"'), '弹窗必须有背景关闭元素（UW-5）');
    assert.ok(html.includes('出战配置1：已保存 · 出战中'), `状态行：${format.configStatusText(h.state(), 'slot1')}`);

    // 角色模板：名字（+ 品质）
    const role = slot.loadout.role;
    assert.ok(role, 'starter 的 slot1 应有角色');
    assert.ok(html.includes(format.itemTitle(role)), `角色模板行应显示 ${format.itemTitle(role)}`);
    // 角色插槽：**有几个显示几个**，每个标注插槽类型
    role.slots.forEach((s, i) => {
      assert.ok(html.includes('插槽' + (i + 1) + '（' + s.type + '）'), `缺少「插槽${i + 1}（${s.type}）」`);
    });
    assert.equal(tagsWith(html, 'data-action="plugin-pick" data-slot="slot1" data-pos="role"').length, role.slots.length,
      '角色插件插槽行的数量必须等于该角色实际的插槽数');
    // 技能 1/2/3 各自的名称与插槽
    for (let k = 0; k < 3; k += 1) {
      const sk = slot.loadout.skills[k];
      assert.ok(html.includes(format.itemTitle(sk)), `技能${k + 1} 行应显示 ${format.itemTitle(sk)}`);
      (sk.slots || []).forEach((s, i) => {
        assert.ok(html.includes('技能' + (k + 1) + '·插槽' + (i + 1) + '（' + s.type + '）'),
          `缺少「技能${k + 1}·插槽${i + 1}（${s.type}）」`);
      });
    }
    // 战斗 AI：显示 **AI 名字**（来自 GET /me/ai，而不是裸 aiId）
    const aiEnv = await h.api.aiList(h.state().session.token);
    const aiName = format.aiCandidatesOf(aiEnv.envelope).find((x) => x.aiId === slot.loadout.aiId).name;
    assert.ok(html.includes(aiName), `战斗AI 行应显示名字 ${aiName}`);
    assert.ok(!html.includes('战斗AI：' + slot.loadout.aiId), 'AI 位置不得只显示裸 aiId');

    // 配置 2 全空：5 个位置全部显示 `空`，且 `空` 是可点按钮
    await h.run('config-open', { slot: 'slot2' });
    const emptyHtml = h.html();
    assert.equal(tagsWith(emptyHtml, '>空</button>').length, 5, '空配置应有 5 个可点的「空」位置');
    for (const pos of ['role', 'skill0', 'skill1', 'skill2', 'ai']) {
      const action = pos === 'ai' ? 'ai-pick' : 'slot-pick';
      assert.equal(tagsWith(emptyHtml, `data-action="${action}" data-slot="slot2" data-pos="${pos}"`).length, 1,
        `位置 ${pos} 必须是可点元素`);
    }
    assert.ok(emptyHtml.includes('出战配置2：已保存 · 非出战 · 草稿不完整（缺少角色物品、技能位置缺失: 0、技能位置缺失: 1、技能位置缺失: 2、缺少 AI 程序）'),
      `全空配置的状态行：${format.configStatusText(h.state(), 'slot2')}`);
  });
});

/* ---------- CF-2：三个候选弹窗 ---------- */

test('CF-2 候选弹窗：slot-pick（同分类 + 空）/ plugin-pick（全部列出，不匹配标灰+原因）/ ai-pick（库条目）', async () => {
  await withFixture(async (h) => {
    await h.run('config-open', { slot: 'slot2' });

    // ① slot-pick：仓库里的**同分类**物品（角色）+ `空`
    const whEnv = h.state().warehouse.envelope;
    const roles = format.bucketItems(whEnv, 'role');
    await h.run('slot-pick', { slot: 'slot2', pos: 'role' });
    assert.deepEqual(h.state().modal, { kind: 'slot-pick', slotId: 'slot2', pos: 'role' });
    const pickHtml = h.html();
    for (const r of roles) assert.ok(pickHtml.includes(format.itemTitle(r)), `候选缺少角色 ${r.name}`);
    assert.ok(!pickHtml.includes(format.itemTitle(format.bucketItems(whEnv, 'skill')[0])), '角色候选里不得出现技能');
    assert.equal(tagsWith(pickHtml, 'data-action="slot-set"').length, roles.length + 1, '候选 = 同分类全部 + 1 个「空」');
    assert.equal(tagsWith(pickHtml, 'data-action="slot-set" data-slot="slot2" data-pos="role" data-empty="1"').length, 1,
      '非出战配置必须提供「空」选项');
    // ①b D-163：starter 的角色已被 **slot1** 引用 → 在 slot2 的角色候选里必须标灰 + 写明原因
    const roleVm = format.viewModel(h.state());
    const usedRow = roleVm.modal.rows.find((r) => r.buttons[0].uid === whEnv.data.buckets.role[0].uid);
    assert.ok(usedRow && usedRow.buttons[0].disabled === true, '已被他配置引用的角色候选必须标灰');
    assert.match(usedRow.text, /^已被配置\S*使用（一件物品同时只能装配到一份配置）$/,
      `标灰必须写明 D-163 的原因：${JSON.stringify(usedRow.text)}`);

    // ② 选中夹具角色（本地草稿）→ 该角色有 2 个插槽（atk / def）
    await h.run('slot-set', { slot: 'slot2', pos: 'role', uid: FIX.role });
    assert.equal(h.state().configs.draft.loadout.role.uid, FIX.role);
    assert.equal(h.state().configs.dirty, true, '本地替换后应标记未保存');
    assert.equal(h.state().modal.kind, 'config', '选完回到编辑器');

    // ③ plugin-pick：**全部列出**同分类插件；与槽 type 不匹配的 → 标灰 + 写原因（B-8）
    await h.run('plugin-pick', { slot: 'slot2', pos: 'role', idx: '0' });
    assert.deepEqual(h.state().modal, { kind: 'plugin-pick', slotId: 'slot2', pos: 'role', idx: 0 });
    const pluginHtml = h.html();
    const rolePlugins = format.bucketItems(h.state().warehouse.envelope, 'rolePlugin');
    const setTags = tagsWith(pluginHtml, 'data-action="plugin-set"');
    assert.equal(setTags.length, rolePlugins.length, '插件候选必须**全部列出**（不隐藏不匹配项）');
    const mismatch = rolePlugins.filter((p) => p.slot !== 'atk');
    assert.ok(mismatch.length > 0, '夹具应含类型不匹配的插件');
    // D-163：除"类型不符"外，**已装配**（装在仓库某件物品的槽上）的候选也要标灰 ——
    //   前端不读 `equipped` 字段，而是从已登记的 `slots[].pluginUid` 推导（与 format.pluginEquippedOf 同口径）。
    const equippedUids = new Set();
    for (const bucket of ['role', 'skill']) {
      for (const it of format.bucketItems(h.state().warehouse.envelope, bucket)) {
        for (const s of (it.slots || [])) if (s && s.pluginUid) equippedUids.add(s.pluginUid);
      }
    }
    const expectDisabled = rolePlugins.filter((p) => p.slot !== 'atk' || equippedUids.has(p.uid));
    assert.ok(equippedUids.size > 0, 'starter/夹具应含已装配插件（用于覆盖 D-163 的标灰规则）');
    assert.equal(setTags.filter((t) => t.includes('disabled')).length, expectDisabled.length,
      `标灰集合 = 类型不符 ∪ 已装配（D-163）；实际 disabled=${setTags.filter((t) => t.includes('disabled')).length}，`
      + `期望 ${expectDisabled.length}（类型不符 ${mismatch.length} + 已装配 ${equippedUids.size} 去重后）`);
    assert.equal(setTags.filter((t) => !t.includes('disabled')).length, rolePlugins.length - expectDisabled.length,
      '其余候选可点');
    assert.ok(pluginHtml.includes('此槽只能装 atk'), '标灰的候选必须写明原因（此槽只能装 <type>）');
    // D-163：**任何**被标灰的候选都必须带一条非空原因（不允许"默默变灰"）；原因可能是类型不符、
    //   `已被装配（请先拆卸）`、`已被配置N使用…` 或 `本配置已在其它位置使用…`
    const pluginVm = format.viewModel(h.state());
    const greyedRows = pluginVm.modal.rows.filter((r) => r.buttons[0].disabled === true);
    assert.equal(greyedRows.length, expectDisabled.length, '标灰行数应与期望一致');
    for (const row of greyedRows) {
      assert.ok(typeof row.text === 'string' && row.text !== '', `标灰的候选必须写明原因：${JSON.stringify(row)}`);
    }
    assert.ok(greyedRows.some((r) => /^此槽只能装 atk$/.test(r.text)), '类型不符的行必须给类型原因');
    assert.ok(greyedRows.every((r) => /^此槽只能装 atk$|^已被装配（请先拆卸）$|^已被配置\S*使用（一件物品同时只能装配到一份配置）$|^本配置已在其它位置使用（一件物品只能占一个位置）$/.test(r.text)),
      `标灰原因必须来自已登记的四种之一：${JSON.stringify(greyedRows.map((r) => r.text))}`);
    assert.ok(pluginHtml.includes('目标槽类型：atk'), '应显示目标槽类型');
    assert.equal(tagsWith(pluginHtml, 'data-action="plugin-clear"').length, 1, '插件弹窗必须有「清空此槽」');

    // ④ ai-pick：列 GET /me/ai 的条目（名字）+ `空`（非出战）
    const aiEnv = await h.api.aiList(h.state().session.token);
    await h.run('ai-pick', { slot: 'slot2' });
    assert.deepEqual(h.state().modal, { kind: 'ai-pick', slotId: 'slot2' });
    const aiHtml = h.html();
    for (const ai of format.aiCandidatesOf(aiEnv.envelope)) {
      assert.ok(aiHtml.includes(ai.name), `AI 候选缺少 ${ai.name}`);
      assert.ok(aiHtml.includes('data-ai-id="' + ai.aiId + '"'), 'AI 候选必须携带 data-ai-id');
    }
    assert.equal(tagsWith(aiHtml, 'data-action="ai-set" data-slot="slot2" data-empty="1"').length, 1, '非出战配置的 AI 候选含「空」');
  }, 'cfe2user');
});

/* ---------- CF-3：两步顺序（本批最容易错的一条） ---------- */

test('CF-3 两步顺序：装配 → 草稿用响应里的更新物品 → 保存后 GET /me/configs 的引用真的变了', async () => {
  await withFixture(async (h) => {
    await h.run('config-open', { slot: 'slot2' });
    await h.run('slot-pick', { slot: 'slot2', pos: 'role' });
    await h.run('slot-set', { slot: 'slot2', pos: 'role', uid: FIX.role });

    const before = h.state().configs.draft.loadout.role;
    assert.equal(before.slots[0].pluginUid, null, '前置：夹具角色的 atk 槽是空的');
    assert.equal(h.state().warehouse.envelope.data.buckets.role.find((i) => i.uid === FIX.role).slots[0].pluginUid, null);

    // ① 装配（插件"装上"改的是**仓库里那件物品**）
    await h.run('plugin-pick', { slot: 'slot2', pos: 'role', idx: '0' });
    const nBefore = h.counter.n;
    await h.run('plugin-set', { slot: 'slot2', pos: 'role', idx: '0', uid: FIX.atkPlugin });
    assert.equal(h.counter.n, nBefore + 1, '装配只发一个请求（响应自带 warehouse/usage/caps，无需再拉）');
    assert.deepEqual(h.assembleCalls, [{ targetUid: FIX.role, pluginUid: FIX.atkPlugin, slotIndex: 0 }],
      `装配请求体：${JSON.stringify(h.assembleCalls)}`);
    assert.match(h.notice(), /^已装配（已写入仓库那件物品；点「保存」后才进这份配置）$/,
      `装配成功文案必须写明"改的是仓库物品、不是配置"：${h.notice()}`);
    assert.equal(h.state().modal.kind, 'config', '装配后回到编辑器');

    // ② 草稿里那件物品必须是**响应回带的更新后物品**（不是原对象、也不只是"记忆里改了一下"）
    const after = h.state().configs.draft.loadout.role;
    assert.notStrictEqual(after, before, '第②步必须换用响应回带的那件物品（只调①不改草稿 = 界面看着换了、保存后没换）');
    assert.equal(after.slots[0].pluginUid, FIX.atkPlugin, '草稿的 atk 槽必须已引用该插件');
    assert.equal(after.slots[1].pluginUid, null, '其它插槽不受影响');
    // state.warehouse 也来自同一响应（usage/caps/buckets 一并刷新，仓库屏的 [装配于配置N] 不会过期）
    const whRole = format.bucketItems(h.state().warehouse.envelope, 'role').find((i) => i.uid === FIX.role);
    assert.equal(whRole.slots[0].pluginUid, FIX.atkPlugin, 'state.warehouse 必须来自装配响应（而不是旧快照）');
    assert.equal(format.capOf(h.state().warehouse.envelope, 'role'), 500, '装配响应回带的 caps 已并回');

    // ③ 填满 5 个位置 → 保存 → 服务端配置里的引用**真的**变了
    await fillSlot(h, 'slot2', { roleUid: FIX.role, skillUids: FIX.skills });
    const saveBefore = h.counter.n;
    await h.run('config-save');
    assert.equal(h.notice(), '已保存', `保存应成功（非出战槽允许不完整，此处已完整）：${h.notice()}`);
    assert.equal(h.counter.n, saveBefore + 2, '保存 = PUT /me/configs(1) + 静默刷新仓库(1)');
    assert.equal(h.saveCalls.length, 1);
    assert.equal(h.saveCalls[0].slotId, 'slot2');
    assert.equal(h.saveCalls[0].loadout.role.slots[0].pluginUid, FIX.atkPlugin, '保存的正文里必须已含装配结果');

    const slot = await h.slotOf('slot2');
    assert.equal(slot.loadout.role.uid, FIX.role, '服务端配置的角色引用');
    assert.equal(slot.loadout.role.slots[0].pluginUid, FIX.atkPlugin,
      '服务端配置（GET /me/configs）的插槽引用必须真的变了 —— 这是"两步顺序"的最终证据');
    // 服务端仓库侧同样一致
    const roleItem = await h.itemOf(FIX.role);
    assert.equal(roleItem.slots[0].pluginUid, FIX.atkPlugin, '仓库里那件物品也已装配');
  }, 'cfe3user');
});

/* ---------- CF-4：出战中的配置（B-5） ---------- */

test('CF-4 出战中的配置：候选无「空」；插件可「清空此槽」；角色/技能置空 → 409 → 可读文案', async () => {
  await withHarness(async (h) => {
    await h.signUp('cfe4user');
    await h.run('config-open', { slot: 'slot1' });
    const original = (await h.slotOf('slot1')).loadout;

    // ① 出战中的配置不提供「空」选项（只能替换）
    await h.run('slot-pick', { slot: 'slot1', pos: 'role' });
    const pickHtml = h.html();
    assert.equal(tagsWith(pickHtml, 'data-empty="1"').length, 0, '出战中的配置不得提供「空」候选（B-5）');
    assert.ok(pickHtml.includes(format.CONFIG_ACTIVE_HINT), '必须提示「出战中的配置只能替换，不能拆卸」');
    await h.run('ai-pick', { slot: 'slot1' });
    assert.equal(tagsWith(h.html(), 'data-action="ai-set" data-empty="1"').length, 0, '出战中的配置的 AI 候选也不提供「空」');

    // ② 插件**可以**清空（实测：出战槽清空插件 → 200；只有清空角色/技能才被 D-160 拦下）
    const occupied = original.role.slots.findIndex((s) => typeof s.pluginUid === 'string' && s.pluginUid !== '');
    assert.ok(occupied >= 0, 'starter 已把角色插件装配进 slot1（附录 D），故必有已占用的插槽');
    const pluginUid = original.role.slots[occupied].pluginUid;
    await h.run('plugin-pick', { slot: 'slot1', pos: 'role', idx: String(occupied) });
    await h.run('plugin-clear', { slot: 'slot1', pos: 'role', idx: String(occupied) });
    assert.deepEqual(h.disassembleCalls, [{ targetUid: original.role.uid, slotIndex: occupied }],
      `拆卸请求体：${JSON.stringify(h.disassembleCalls)}`);
    assert.match(h.notice(), /^已拆卸（已更新仓库那件物品；点「保存」后才从这份配置移除）$/,
      `拆卸成功文案同样写明作用对象：${h.notice()}`);
    assert.equal(h.state().configs.draft.loadout.role.slots[occupied].pluginUid, null,
      '草稿必须用响应回带的物品（拆卸同样是两步顺序）');
    await h.run('config-save');
    assert.equal(h.notice(), '已保存', `出战槽清空插件应被允许（实测 200）：${h.notice()}`);
    assert.equal((await h.slotOf('slot1')).loadout.role.slots[occupied].pluginUid, null, '服务端配置的该插槽已清空');
    const roleAfter = await h.itemOf(original.role.uid);
    assert.equal(roleAfter.slots[occupied].pluginUid, null, '仓库里那件角色物品的该插槽也已拆下（响应回带的物品）');

    // ③ 把**角色**置空 → 409 loadout_invalid → 翻成玩家可读文案（不是原样抛服务端 message）
    await h.run('slot-set', { slot: 'slot1', pos: 'role', empty: '1' });
    await h.run('config-save');
    assert.match(h.notice(), /出战中的配置必须完整，只能替换，不能拆卸/, `实际文案：${h.notice()}`);
    assert.match(h.notice(), /缺少角色物品/, '必须逐位置说明缺什么');
    assert.equal((await h.slotOf('slot1')).loadout.role.uid, original.role.uid, '保存失败不得改动服务端配置');

    // ④ 把**技能**置空 → 409（逐条 details：技能位置缺失: N）
    await h.run('slot-set', { slot: 'slot1', pos: 'role', uid: original.role.uid });
    await h.run('slot-set', { slot: 'slot1', pos: 'skill2', empty: '1' });
    await h.run('config-save');
    assert.match(h.notice(), /技能位置缺失: 2/, `实际文案：${h.notice()}`);
    assert.equal((await h.slotOf('slot1')).loadout.skills[2].uid, original.skills[2].uid, '服务端技能位置仍是原值');
  });
});

/* ---------- CF-5：从全空到出战 ---------- */

test('CF-5 配置2 从全空逐位置装配 → 保存 → 设为出战 200 → 主界面/仓库标记同步', async () => {
  await withFixture(async (h) => {
    await h.run('config-open', { slot: 'slot2' });
    // B-4：配置 2 初始 5 个位置全空
    const emptyDraft = h.state().configs.draft.loadout;
    assert.equal(emptyDraft.role, null);
    assert.deepEqual(emptyDraft.skills, [null, null, null]);
    assert.equal(emptyDraft.ai, null);

    // 不完整时「设为出战」由**服务端**拦下（见 CF-6），此处先逐位置补齐
    const filled = await fillSlot(h, 'slot2');
    // 顺便给角色的 atk 槽装一个插件（再次覆盖两步顺序：装配 → 草稿 → 保存）
    await h.run('plugin-pick', { slot: 'slot2', pos: 'role', idx: '0' });
    await h.run('plugin-set', { slot: 'slot2', pos: 'role', idx: '0', uid: FIX.atkPlugin });
    assert.equal(h.state().configs.draft.loadout.role.slots[0].pluginUid, FIX.atkPlugin);
    assert.equal(format.configStatusText(h.state(), 'slot2'),
      '出战配置2：未保存 · 非出战 · 草稿完整', '状态行：未保存 + 非出战 + 草稿完整');

    await h.run('config-save');
    assert.equal(h.notice(), '已保存');
    assert.equal(h.state().configs.dirty, false, '保存后脏标记归零');
    assert.equal(format.configStatusText(h.state(), 'slot2'), '出战配置2：已保存 · 非出战 · 草稿完整');

    const before = h.counter.n;
    await h.run('config-activate');
    assert.equal(h.notice(), '已设为出战配置');
    // activate + 配置列表刷新 + 仓库刷新 + /me 刷新（出战槽标记）
    assert.equal(h.counter.n, before + 4, '设为出战 = activate + configs + warehouse + /me 四次请求');
    assert.deepEqual(h.activateCalls, ['slot2']);
    assert.equal((await h.fetchConfigs()).data.activeSlotId, 'slot2', '服务端 activeSlotId 已切换');
    // 前端三处标记同步
    assert.equal(h.state().configs.data.data.activeSlotId, 'slot2', '配置列表已刷新');
    assert.match(format.profileLines(h.state().profile).join('\n'), /出战槽：slot2/, '主界面/档案的出战槽标记已同步');
    assert.ok(format.usageText(h.state().warehouse.envelope, filled.roleUid).includes('配置2'),
      `仓库 usage 必须标记配置2：${format.usageText(h.state().warehouse.envelope, filled.roleUid)}`);
    assert.equal(format.configStatusText(h.state(), 'slot2'), '出战配置2：已保存 · 出战中 · 草稿完整');
    // 切换后 B-5 生效：候选不再提供「空」
    await h.run('slot-pick', { slot: 'slot2', pos: 'role' });
    assert.equal(tagsWith(h.html(), 'data-empty="1"').length, 0, '切换为出战后，候选里不再有「空」');
  }, 'cfe5user');
});

/* ---------- CF-6：设为出战失败路径 ---------- */

test('CF-6 设为出战：不完整 → 409 cannot_activate_incomplete 逐位置文案；有未保存修改先要求保存', async () => {
  await withFixture(async (h) => {
    // ① 全空配置：先保存（非出战槽不校验完整性 → 200 complete:false），再设为出战 → 409
    await h.run('config-open', { slot: 'slot3' });
    const saveBefore = h.counter.n;
    await h.run('config-save');
    assert.equal(h.notice(), '已保存（配置不完整：缺少角色物品、技能位置缺失: 0、技能位置缺失: 1、技能位置缺失: 2、缺少 AI 程序，补齐后才能设为出战）',
      `不完整保存的文案：${h.notice()}`);
    // 保存 = PUT(1) + 静默刷新仓库(1)；且服务端确实以 200 + complete:false 接受
    assert.equal(h.counter.n, saveBefore + 2, '不完整保存仍发 PUT + 静默刷新仓库');
    assert.equal(h.saveCalls.length, 1);

    await h.run('config-activate');
    assert.match(h.notice(), /^该配置不完整，无法设为出战（/, `实际文案：${h.notice()}`);
    for (const part of ['缺少角色物品', '技能位置缺失: 0', '技能位置缺失: 1', '技能位置缺失: 2', '缺少 AI 程序']) {
      assert.ok(h.notice().includes(part), `逐位置文案缺少「${part}」：${h.notice()}`);
    }
    assert.deepEqual(h.activateCalls, ['slot3'], '确实问了服务端（409 由服务端判定，不是客户端拦下）');
    assert.equal((await h.fetchConfigs()).data.activeSlotId, 'slot1', '设为出战失败不得切换出战槽');

    // ② 有未保存修改时不得"看着是新的、出战的是旧的"：先要求保存
    await h.run('slot-set', { slot: 'slot3', pos: 'role', uid: FIX.role });
    assert.equal(h.state().configs.dirty, true);
    const nBefore = h.counter.n;
    await h.run('config-activate');
    assert.match(h.notice(), /请先点「保存」再设为出战/);
    assert.equal(h.counter.n, nBefore, '有未保存修改时不得发 activate 请求');
    assert.equal(h.activateCalls.length, 1, 'activate 调用次数不变');
  }, 'cfe6user');
});

/* ---------- CF-7：点弹窗外 ---------- */

test('CF-7 点弹窗外 → 关闭 + 丢弃草稿；再打开是服务端原状（B-9）', async () => {
  await withFixture(async (h) => {
    await h.run('config-open', { slot: 'slot2' });
    await h.run('slot-pick', { slot: 'slot2', pos: 'role' });
    await h.run('slot-set', { slot: 'slot2', pos: 'role', uid: FIX.role });
    assert.equal(h.state().configs.dirty, true, '前置：有未保存修改');

    // 背景元素 = data-action="modal-close"（render 统一产出）
    assert.ok(h.html().includes('data-action="modal-close"'));
    await h.run('modal-close');
    assert.equal(h.state().modal, null, '关闭弹窗');
    assert.equal(h.state().configs.draft, null, '必须丢弃未提交草稿');
    assert.equal(h.state().configs.dirty, false);
    assert.ok(!h.html().includes('id="modal"'));

    // 再打开：原状（草稿重新来自服务端）
    await h.run('config-open', { slot: 'slot2' });
    assert.equal(h.state().configs.draft.loadout.role, null, '再打开必须是服务端原状（未提交的替换不得残留）');
    assert.equal((await h.slotOf('slot2')).loadout.role, null, '服务端从未被这次编辑改动');
  }, 'cfe7user');
});

/* ---------- CF-8：契约三方一致 ---------- */

// 分册 §5.1 的 me/configs 槽级字段与 §5.2 的 me/ai 条目字段
function documentedSlotFields() {
  const doc = fs.readFileSync(DOC3, 'utf8');
  const out = new Set();
  for (const line of doc.slice(doc.indexOf('## 5.'), doc.indexOf('## 6.')).split('\n')) {
    if (!line.startsWith('|') || !line.includes('me/configs')) continue;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      for (const part of m[1].split('/')) {
        const token = part.trim();
        // `data.slots[].loadout.role` → ['loadout','role']；裸字段 `slotId` → ['slotId']
        const segs = token.replace(/\[\]/g, '').split('.').filter(Boolean);
        if (segs[0] === 'data') segs.shift();
        if (segs[0] === 'slots') segs.shift();
        for (const s of segs) if (/^[a-zA-Z][A-Za-z0-9_]*$/.test(s)) out.add(s);
      }
    }
  }
  return out;
}

function documentedAiItemFields() {
  const doc = fs.readFileSync(DOC3, 'utf8');
  for (const line of doc.slice(doc.indexOf('## 5.'), doc.indexOf('## 6.')).split('\n')) {
    if (!line.startsWith('|') || !line.includes('me/ai')) continue;
    const m = line.match(/data\.items\[\]\.\{([^}]+)\}/);
    if (m) return new Set(m[1].split(',').map((s) => s.trim()));
  }
  return new Set();
}

test('CF-8 契约：槽级/AI 条目字段三方一致（contract == 分册 §5 == format 实读）+ 真实响应可解析', async () => {
  const src = fs.readFileSync(path.join(PUBLIC_DIR, 'format.js'), 'utf8');
  const reads = new Set([...src.matchAll(/pick\(\s*[^,()]+?\s*,\s*'([^']+)'\s*\)/g)].map((m) => m[1]));

  // ① 声明 == 实读（无幽灵声明）
  for (const field of contract.CONFIG_SLOT_FIELDS) {
    assert.ok(reads.has(field), `CONFIG_SLOT_FIELDS 声明了 ${field} 但 format.js 没读`);
  }
  for (const field of contract.AI_ITEM_FIELDS) {
    assert.ok(reads.has(field), `AI_ITEM_FIELDS 声明了 ${field} 但 format.js 没读`);
  }
  // ② 声明 ⊆ 分册 §5 登记（字段名不得来自散文）
  const docSlots = documentedSlotFields();
  for (const field of contract.CONFIG_SLOT_FIELDS) {
    assert.ok(docSlots.has(field), `CONFIG_SLOT_FIELDS 的 ${field} 在 03 §5.1 未登记`);
  }
  const docAi = documentedAiItemFields();
  for (const field of contract.AI_ITEM_FIELDS) {
    assert.ok(docAi.has(field), `AI_ITEM_FIELDS 的 ${field} 在 03 §5.2 未登记`);
  }
  // ③ 从 loadout 里读的物品字段必须落在已登记的 ITEM_DETAIL_FIELDS 内（同一物品形状，不另立一份契约）
  const itemFieldsRead = ['name', 'quality', 'uid', 'slots', 'type', 'pluginUid'];
  for (const field of itemFieldsRead) {
    assert.ok(contract.ITEM_DETAIL_FIELDS.includes(field), `${field} 不在 ITEM_DETAIL_FIELDS（物品字段契约）里`);
  }

  // ③b **审查 F-2 补的强断言**：loadout 正文的字段有两条读取路径 —— `pick()` 字面量与**直接属性访问**
  //   （`loadout.aiId`）。后者不进 ① 的 reads 集合，故"声明 ⊆ 实读"会放过"实读未声明"。
  //   这里做**源码级双向相等**：代码里出现的每个 `loadout.<字段>` 都必须被 CONFIG_LOADOUT_FIELDS 声明，
  //   且声明的每个字段都必须真的被读（反之即幽灵声明）。
  //   ⚠️ 只看代码行：文件头注释里有分册文件名 `03-hub-warehouse-loadout.md`，会误匹配出 `md`。
  const codeLines = src.split('\n').filter((line) => {
    const t = line.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !line.includes('docs/');
  });
  const loadoutReads = [...new Set([...codeLines.join('\n').matchAll(/loadout\.([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map((m) => m[1]))].sort();
  assert.deepEqual(loadoutReads, [...contract.CONFIG_LOADOUT_FIELDS].sort(),
    `format.js 直接读取的 loadout 字段（${loadoutReads.join(',')}）必须与 CONFIG_LOADOUT_FIELDS `
    + `（${contract.CONFIG_LOADOUT_FIELDS.join(',')}）完全一致 —— 少了 aiId 就会让"删除出战配置正在引用的 AI"静默放行`);
  for (const field of contract.CONFIG_LOADOUT_FIELDS) {
    assert.ok(docSlots.has(field), `CONFIG_LOADOUT_FIELDS 的 ${field} 在 03 §5.1 未登记（字段名不得来自散文）`);
  }

  // ④ 真实响应：每条声明字段都能解析到；且编辑器投影不泄漏 undefined
  await withFixture(async (h) => {
    await h.run('config-open', { slot: 'slot1' });
    const env = await h.fetchConfigs();
    const slot = env.data.slots.find((s) => s.slotId === 'slot1');
    for (const field of contract.CONFIG_SLOT_FIELDS) {
      assert.notStrictEqual(format.pick(slot, field), undefined, `真实槽缺少字段 ${field}`);
    }
    const role = format.pick(slot, 'loadout.role');
    for (const field of contract.CONFIG_LOADOUT_FIELDS) {
      assert.notStrictEqual(format.pick(slot, 'loadout.' + field), undefined,
        `真实配置的 loadout 缺少已声明字段 ${field}`);
    }
    for (const field of itemFieldsRead) {
      const value = field === 'type' || field === 'pluginUid'
        ? format.pick((format.pick(role, 'slots') || [])[0] || {}, field)
        : format.pick(role, field);
      assert.notStrictEqual(value, undefined, `真实配置的角色物品缺少字段 ${field}`);
    }
    const aiEnv = await h.api.aiList(h.state().session.token);
    for (const ai of format.aiCandidatesOf(aiEnv.envelope)) {
      for (const field of contract.AI_ITEM_FIELDS) {
        assert.notStrictEqual(format.pick(ai, field), undefined, `真实 AI 条目缺少字段 ${field}`);
      }
    }
    const vm = format.viewModel(h.state());
    for (const line of vm.modal.lines) assert.ok(!String(line).includes('undefined'), `状态行泄漏：${line}`);
    for (const row of vm.modal.rows) {
      assert.ok(!String(row.text).includes('undefined'));
      for (const button of row.buttons) assert.ok(!String(button.label).includes('undefined'), `候选标签泄漏：${button.label}`);
    }
  }, 'cfe8user');
});

/* ---------- CF-10：插件装配/拆卸的失败路径（§6 全部失败路径） ---------- */

test('CF-10 插件装配/拆卸失败路径：类型不符 / 物品不存在 / 槽已占用 / 空槽 都被翻成可读文案（§6）', async () => {
  await withFixture(async (h) => {
    await h.run('config-open', { slot: 'slot2' });
    await h.run('slot-set', { slot: 'slot2', pos: 'role', uid: FIX.role });
    const draftRole = () => h.state().configs.draft.loadout.role;

    // ① 未安装物品的位置：本地前置拒绝，不发请求（客户端预过滤）
    const nBefore = h.counter.n;
    await h.run('plugin-set', { slot: 'slot2', pos: 'skill0', idx: '0', uid: FIX.skillPlugin });
    assert.equal(h.counter.n, nBefore, '该位置未装物品 → 不发请求');
    assert.match(h.notice(), /插槽寻址无效/);

    // ② slot_type_mismatch：def 插件装 atk 槽（UI 已标灰，这是服务端 409 的兜底文案）
    await h.run('plugin-set', { slot: 'slot2', pos: 'role', idx: '0', uid: FIX.defPlugin });
    assert.match(h.notice(), /该插件不能装入此槽（类型不符）/, `实际文案：${h.notice()}`);
    assert.match(h.notice(), /服务端原文/, '必须附服务端 message 原文（§6）');
    assert.equal(draftRole().slots[0].pluginUid, null, '失败不得改动草稿');

    // ③ item_missing：不存在的插件
    await h.run('plugin-set', { slot: 'slot2', pos: 'role', idx: '0', uid: 'no_such_plugin' });
    assert.match(h.notice(), /物品不存在（可能已被清除）/, `实际文案：${h.notice()}`);
    assert.equal(draftRole().slots[0].pluginUid, null);

    // ④ slot_occupied：先成功装一个，再往同一槽装第二个同类型插件
    await h.run('plugin-set', { slot: 'slot2', pos: 'role', idx: '0', uid: FIX.atkPlugin });
    assert.match(h.notice(), /^已装配/);
    assert.equal(draftRole().slots[0].pluginUid, FIX.atkPlugin);
    await h.run('plugin-set', { slot: 'slot2', pos: 'role', idx: '0', uid: FIX.atkPlugin2 });
    assert.match(h.notice(), /该插槽已装配插件，请先拆卸/, `实际文案：${h.notice()}`);
    assert.equal(draftRole().slots[0].pluginUid, FIX.atkPlugin, '失败后草稿保持原装配');

    // ⑤ slot_empty：对空槽执行「清空此槽」→ 404
    await h.run('plugin-clear', { slot: 'slot2', pos: 'role', idx: '1' });
    assert.match(h.notice(), /该插槽当前为空/, `实际文案：${h.notice()}`);
    assert.deepEqual(h.disassembleCalls, [{ targetUid: FIX.role, slotIndex: 1 }], '确实问了服务端');
    assert.equal(draftRole().slots[1].pluginUid, null);
  }, 'cfe10user');
});

/* ---------- CF-9：DOM 装配层（事件委托 → payload → 动作） ---------- */

function fakeDom() {
  const listeners = {};
  const host = {
    writes: 0,
    _html: '',
    set innerHTML(value) { this.writes += 1; this._html = String(value); },
    get innerHTML() { return this._html; },
  };
  return {
    host,
    doc: {
      title: '',
      getElementById: (id) => (id === 'view' ? host : null),
      addEventListener: (type, fn) => { listeners[type] = fn; },
    },
    fire: (type, event) => listeners[type](event),
  };
}

function fakeButton(action, dataset) {
  return {
    tagName: 'BUTTON',
    type: 'button',
    dataset: dataset || {},
    getAttribute: (name) => (name === 'data-action' ? action : null),
  };
}

test('CF-9 DOM 装配层：data-pos / data-idx / data-empty / data-ai-id → payload → 动作（含两步顺序）', async () => {
  const dom = fakeDom();
  const calls = [];
  const list = await apiMod.createApi({ baseUrl: '' }).configs;   // 仅为断言导出存在，不使用
  assert.equal(typeof list, 'function');

  // 手写夹具（形状取自真实响应：03 §5.1/§5.2）
  const roleItem = {
    uid: 'item_0', kind: 'role', name: '均衡', quality: 'common', slotCount: 1,
    slots: [{ type: 'mp', pluginUid: null }], stats: {}, regen: {}, pluginPoints: 3, templateId: 'role_bal',
  };
  const pluginItem = {
    uid: 'item_4', kind: 'rolePlugin', id: 'rp_mp_regen', name: 'MP 优化·回复', slot: 'mp',
    category: 'MP 优化', quality: 'common', tier: 1, pointCost: 1, affixes: [],
  };
  const loadout = { role: roleItem, skills: [null, null, null], ai: { type: 'program' }, aiId: 'ai_seed' };
  const warehouseEnv = {
    ok: true,
    data: {
      buckets: { role: [roleItem.clone ? roleItem : roleItem], skill: [], rolePlugin: [pluginItem], skillPlugin: [] },
      usage: {}, caps: { role: 500, skill: 500, rolePlugin: 500, skillPlugin: 500 }, counts: {},
    },
  };
  const configsEnv = {
    ok: true,
    data: { slots: [{ slotId: 'slot1', name: '默认配置', isDefault: true, loadout, snapshot: { hash: 'h' } }], activeSlotId: 'slot1', maxSlots: 3 },
  };
  const aiEnv = { ok: true, data: { items: [{ aiId: 'ai_seed', name: '新手AI', program: { type: 'program' } }], count: 1, max: 100, usage: {} } };
  const assembledRole = {
    uid: 'item_0', kind: 'role', name: '均衡', quality: 'common', slotCount: 1,
    slots: [{ type: 'mp', pluginUid: 'item_4' }], stats: {}, regen: {}, pluginPoints: 3, templateId: 'role_bal',
  };
  const fakeApi = {
    me: () => Promise.resolve({ transport: 'error', message: '本用例不发 /me' }),
    configs: () => Promise.resolve({ transport: 'response', status: 200, envelope: configsEnv }),
    warehouse: () => Promise.resolve({ transport: 'response', status: 200, envelope: warehouseEnv }),
    aiList: () => Promise.resolve({ transport: 'response', status: 200, envelope: aiEnv }),
    assemble: (token, input) => {
      calls.push({ op: 'assemble', input });
      return Promise.resolve({
        transport: 'response', status: 200,
        envelope: {
          ok: true,
          data: {
            warehouse: { buckets: { role: [assembledRole], skill: [], rolePlugin: [{ ...pluginItem, equipped: true }], skillPlugin: [] } },
            usage: { item_0: { slotIds: ['slot1'] } },
            counts: { role: 1, skill: 0, rolePlugin: 1, skillPlugin: 0 },
            caps: { role: 500, skill: 500, rolePlugin: 500, skillPlugin: 500 },
          },
        },
      });
    },
    saveConfig: (token, slotId, input) => {
      calls.push({ op: 'saveConfig', slotId, input });
      return Promise.resolve({ transport: 'response', status: 200, envelope: { ok: true, data: {} } });
    },
  };
  const map = new Map();
  const win = { localStorage: { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) } };
  const app = appMod.createApp({ doc: dom.doc, win, DL: { store, format, render, actions }, api: fakeApi });
  await app.start();

  app.dispatch({ type: 'session.set', token: 'tk', publicId: 'u_cfg', nickname: '甲', expiresAt: null, isAdmin: false });
  app.dispatch({ type: 'profile.set', envelope: null });
  app.dispatch({ type: 'view.go', view: 'hub' });

  // hub 的「出战配置1」按钮（data-slot）→ config-open → 编辑器
  dom.fire('click', { target: { closest: () => fakeButton('config-open', { slot: 'slot1' }) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.store.getState().modal.kind, 'config');
  assert.equal(app.store.getState().configs.dirty, false);
  assert.ok(dom.host.innerHTML.includes('出战配置1：'));

  // 角色位置（data-pos=role）→ slot-pick → slot-set 带 data-empty
  dom.fire('click', { target: { closest: () => fakeButton('slot-pick', { slot: 'slot1', pos: 'role' }) } });
  assert.equal(app.store.getState().modal.kind, 'slot-pick');
  dom.fire('click', { target: { closest: () => fakeButton('slot-set', { slot: 'slot1', pos: 'role', empty: '1' }) } });
  assert.equal(app.store.getState().configs.draft.loadout.role, null, 'data-empty 必须被解析为"置空"');
  assert.equal(app.store.getState().modal.kind, 'config', '选完回到编辑器');

  // 恢复角色（data-uid）→ 插槽（data-pos + data-idx）→ 装配（两步顺序）
  dom.fire('click', { target: { closest: () => fakeButton('slot-set', { slot: 'slot1', pos: 'role', uid: 'item_0' }) } });
  assert.equal(app.store.getState().configs.draft.loadout.role.uid, 'item_0');
  dom.fire('click', { target: { closest: () => fakeButton('plugin-pick', { slot: 'slot1', pos: 'role', idx: '0' }) } });
  assert.deepEqual(app.store.getState().modal, { kind: 'plugin-pick', slotId: 'slot1', pos: 'role', idx: 0 },
    'data-idx 必须被解析为数字下标');
  dom.fire('click', { target: { closest: () => fakeButton('plugin-set', { slot: 'slot1', pos: 'role', idx: '0', uid: 'item_4' }) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls[0], { op: 'assemble', input: { targetUid: 'item_0', pluginUid: 'item_4', slotIndex: 0 } });
  assert.equal(app.store.getState().configs.draft.loadout.role.slots[0].pluginUid, 'item_4',
    'DOM 层同样必须走"装配 → 用响应物品替换草稿"的两步顺序');
  // 保存（config-save）→ 请求体 = 草稿
  dom.fire('click', { target: { closest: () => fakeButton('config-save') } });
  await new Promise((resolve) => setImmediate(resolve));
  const saved = calls.find((c) => c.op === 'saveConfig');
  assert.equal(saved.slotId, 'slot1');
  assert.equal(saved.input.loadout.role.slots[0].pluginUid, 'item_4');
  // AI 位置（data-ai-id）
  dom.fire('click', { target: { closest: () => fakeButton('ai-pick', { slot: 'slot1', pos: 'ai' }) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.store.getState().modal.kind, 'ai-pick');
  dom.fire('click', { target: { closest: () => fakeButton('ai-set', { slot: 'slot1', aiId: 'ai_seed' }) } });
  assert.equal(app.store.getState().configs.draft.loadout.aiId, 'ai_seed');
  // 点弹窗外 → 关闭 + 丢弃草稿
  dom.fire('click', { target: { closest: () => fakeButton('modal-close') } });
  assert.equal(app.store.getState().modal, null);
  assert.equal(app.store.getState().configs.draft, null);
});

/* ---------- CF-11：独立审查 F-1（取消弹窗不得被 in-flight 响应撤销） ---------- */

// 审查 F-1：`modal-close`（背景元素）**不随 busy 禁用**，故用户可以在动作等待响应期间点外面关闭。
//   修前：await 回来后无条件 `modal.set` → 弹窗被"复活"，而草稿已被丢弃 → 编辑器按**服务端副本**渲染
//   （看起来"什么都没发生"），可提示写着「已装配」、仓库里那件物品也真的装上了 —— 三处互相矛盾。
//   修后：只有"弹窗对象引用未变"才重新弹开；被取消时提示保留并写明"服务端已落档、关闭不撤销"。
test('CF-11 F-1 回归：等待响应期间点弹窗外关闭 → 弹窗不得被复活（草稿保持丢弃）', async () => {
  await withFixture(async (h) => {
    // 让装配/取 AI 库这两个 await 变慢，从而稳定地在"响应未到"时点关闭（确定性，不靠竞态碰运气）
    const slow = (fn, ms) => (...a) => new Promise((resolve) => setTimeout(() => resolve(fn(...a)), ms));
    h.api.assemble = slow(h.api.assemble, 60);
    h.api.aiList = slow(h.api.aiList, 60);

    // ① 装配路径：编辑 slot2 的角色插件
    await h.run('config-open', { slot: 'slot2' });
    await h.run('slot-pick', { slot: 'slot2', pos: 'role' });
    await h.run('slot-set', { slot: 'slot2', pos: 'role', uid: FIX.role });
    await h.run('plugin-pick', { slot: 'slot2', pos: 'role', idx: '0' });
    const inflight = h.run('plugin-set', { slot: 'slot2', pos: 'role', idx: '0', uid: FIX.atkPlugin });
    await h.run('modal-close');                      // ← 响应还在路上就点背景关闭
    assert.equal(h.state().modal, null, '前置：用户已关闭');
    assert.equal(h.state().configs.draft, null, '前置：草稿已被丢弃');
    await inflight;                                   // ← 迟到的响应此刻才回来
    assert.equal(h.state().modal, null, 'F-1：弹窗不得被 in-flight 响应复活');
    assert.equal(h.state().configs.draft, null, 'F-1：草稿不得被偷偷重建（否则"看着是草稿、其实服务端已改"）');
    assert.match(h.notice(), /已装配/, '提示必须仍然给出（服务端那一步已经落档）');
    assert.match(h.notice(), /已写入仓库那件物品/,
      'F-3：必须写明"改的是仓库那件物品、且取消弹窗不撤销这一步"');
    const roleItem = await h.itemOf(FIX.role);
    assert.equal(roleItem.slots[0].pluginUid, FIX.atkPlugin,
      'F-3：装配确实落在仓库那件物品上（取消弹窗只丢弃草稿，不回滚服务端）');

    // ② ai-pick 路径（同一个 await 模式）
    await h.run('config-open', { slot: 'slot2' });
    const inflightAi = h.run('ai-pick', { slot: 'slot2' });
    await h.run('modal-close');
    assert.equal(h.state().modal, null, '前置：已关闭');
    await inflightAi;
    assert.equal(h.state().modal, null, 'F-1：ai-pick 同样不得复活弹窗');
  }, 'cfe11user');
});
