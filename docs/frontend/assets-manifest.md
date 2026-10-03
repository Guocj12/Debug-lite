# UI 素材清单（自动生成，勿手改）

> 生成命令：`node tools/layout/asset-manifest.js`（也可以用布局台的「素材清单」按钮）
> 出图规范：把文件按 **文件名 = 清单里的 ID** 丢进仓库根目录的 `assets-inbox/`，
> 然后跑 `node tools/layout/apply-assets.js` —— 它会改名/转格式/缩放并放进 `public/assets/` 对应目录。

**总览**：共 151 项 ｜ 已有 0 ｜ 收件夹待归位 0 ｜ **缺 147**（可选 4）

| 类别 | 总数 | 已有 | 待归位 | 缺 | 建议规格 | 说明 |
|---|---|---|---|---|---|---|
| 背景图 | 1 | 0 | 0 | 1 | 1920×1080 · webp | 背景图，等比铺满（cover） |
| 角色 | 11 | 0 | 0 | 11 | 512×512 · webp | 角色立绘/图标，透明底，正方形 |
| 技能 | 4 | 0 | 0 | 4 | 256×256 · webp | 技能图标，透明底，正方形 |
| 插件 | 41 | 0 | 0 | 41 | 128×128 · webp | 插件图标，透明底，正方形 |
| AI 积木节点 | 54 | 0 | 0 | 54 | 128×128 · webp | AI 积木节点图标，透明底 |
| 包/宝箱 | 1 | 0 | 0 | 1 | 256×256 · webp | 包/宝箱图标，透明底 |
| 界面按钮/控件 | 25 | 0 | 0 | 25 | 按元素框（见布局表 rect） · webp | 按钮/控件底图；不规则形状交 PNG 透明底，我会描出多边形 |
| 品质边框 | 5 | 0 | 0 | 5 | 256×256 · svg | 品质边框（矢量，颜色按 qualities.json 的 color） |
| 段位图标 | 5 | 0 | 0 | 5 | 64×64 · svg | 段位图标（矢量，颜色按 qualities.json 的 color） |
| 音效（可选） | 4 | 0 | 0 | 4 | — · mp3 | 技能音效（可选；布局表暂时不用） |

## 背景图（1）

| 状态 | 优先级 | 文件名（放进 assets-inbox） | 目标路径 | 名称 | 用途 |
|---|---|---|---|---|---|
| ❌ 缺 | ★ 先做 | `hub_main.webp` | `assets/bg/hub_main.webp` | hub 背景 | hub |

## 角色（11）

| 状态 | 优先级 | 文件名（放进 assets-inbox） | 目标路径 | 名称 | 用途 |
|---|---|---|---|---|---|
| ❌ 缺 | ★ 先做 | `role_bal.webp` | `assets/role/role_bal.webp` | 均衡 | server/data/role-templates.json |
| ❌ 缺 | ★ 先做 | `role_spc_hp.webp` | `assets/role/role_spc_hp.webp` | 特化·HP | server/data/role-templates.json |
| ❌ 缺 | ★ 先做 | `role_spc_atk.webp` | `assets/role/role_spc_atk.webp` | 特化·攻击 | server/data/role-templates.json |
| ❌ 缺 | ★ 先做 | `role_spc_def.webp` | `assets/role/role_spc_def.webp` | 特化·防御 | server/data/role-templates.json |
| ❌ 缺 | ★ 先做 | `role_spc_sp.webp` | `assets/role/role_spc_sp.webp` | 特化·SP | server/data/role-templates.json |
| ❌ 缺 | ★ 先做 | `role_spc_mp.webp` | `assets/role/role_spc_mp.webp` | 特化·MP | server/data/role-templates.json |
| ❌ 缺 | ★ 先做 | `role_exp_hp.webp` | `assets/role/role_exp_hp.webp` | 专家·HP | server/data/role-templates.json |
| ❌ 缺 | ★ 先做 | `role_exp_atk.webp` | `assets/role/role_exp_atk.webp` | 专家·攻击 | server/data/role-templates.json |
| ❌ 缺 | ★ 先做 | `role_exp_def.webp` | `assets/role/role_exp_def.webp` | 专家·防御 | server/data/role-templates.json |
| ❌ 缺 | ★ 先做 | `role_exp_sp.webp` | `assets/role/role_exp_sp.webp` | 专家·SP | server/data/role-templates.json |
| ❌ 缺 | ★ 先做 | `role_exp_mp.webp` | `assets/role/role_exp_mp.webp` | 专家·MP | server/data/role-templates.json |

## 技能（4）

| 状态 | 优先级 | 文件名（放进 assets-inbox） | 目标路径 | 名称 | 用途 |
|---|---|---|---|---|---|
| ❌ 缺 | ★ 先做 | `skill_melee.webp` | `assets/skill/skill_melee.webp` | 近战 | server/data/skill-templates.json |
| ❌ 缺 | ★ 先做 | `skill_straight.webp` | `assets/skill/skill_straight.webp` | 平射 | server/data/skill-templates.json |
| ❌ 缺 | ★ 先做 | `skill_vertical.webp` | `assets/skill/skill_vertical.webp` | 定点 | server/data/skill-templates.json |
| ❌ 缺 | ★ 先做 | `skill_displace.webp` | `assets/skill/skill_displace.webp` | 位移 | server/data/skill-templates.json |

## 插件（41）

| 状态 | 优先级 | 文件名（放进 assets-inbox） | 目标路径 | 名称 | 用途 |
|---|---|---|---|---|---|
| ❌ 缺 | · 后补 | `rp_atk_pct.webp` | `assets/plugin/rp_atk_pct.webp` | 攻击提升·百分比（1 点）（攻击提升） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `rp_atk_flat.webp` | `assets/plugin/rp_atk_flat.webp` | 攻击提升·数值（1 点）（攻击提升） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `rp_hp_pct.webp` | `assets/plugin/rp_hp_pct.webp` | 生命强化·百分比（1 点）（生命强化） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `rp_hp_flat.webp` | `assets/plugin/rp_hp_flat.webp` | 生命强化·数值（1 点）（生命强化） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `rp_def_flat.webp` | `assets/plugin/rp_def_flat.webp` | 防御强化·数值（1 点）（防御强化） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `rp_sp_opt.webp` | `assets/plugin/rp_sp_opt.webp` | SP 优化·上限（1 点）（SP 优化） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `rp_sp_flat.webp` | `assets/plugin/rp_sp_flat.webp` | SP 强化·数值（1 点）（SP 强化） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `rp_mp_opt.webp` | `assets/plugin/rp_mp_opt.webp` | MP 优化·上限（1 点）（MP 优化） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `rp_mp_flat.webp` | `assets/plugin/rp_mp_flat.webp` | MP 强化·数值（1 点）（MP 强化） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `rp_regen.webp` | `assets/plugin/rp_regen.webp` | 再生（回复） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `rp_sp_regen.webp` | `assets/plugin/rp_sp_regen.webp` | 体力循环（SP 优化） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `rp_mp_regen.webp` | `assets/plugin/rp_mp_regen.webp` | 法力循环（MP 优化） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `rp_dodge.webp` | `assets/plugin/rp_dodge.webp` | 闪避（闪避） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `rp_crit.webp` | `assets/plugin/rp_crit.webp` | 暴击（暴击） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `rp_lifesteal.webp` | `assets/plugin/rp_lifesteal.webp` | 吸血（吸血） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `rp_thorns.webp` | `assets/plugin/rp_thorns.webp` | 荆棘（荆棘） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `rp_critdmg.webp` | `assets/plugin/rp_critdmg.webp` | 致命（致命） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `rp_lowhp.webp` | `assets/plugin/rp_lowhp.webp` | 背水（背水） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `sk_mult.webp` | `assets/plugin/sk_mult.webp` | 增伤（增伤） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `sk_crit.webp` | `assets/plugin/sk_crit.webp` | 暴击率（暴击） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `sk_critdmg.webp` | `assets/plugin/sk_critdmg.webp` | 暴击伤害（致命） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `sk_cd_down.webp` | `assets/plugin/sk_cd_down.webp` | 冷却缩减（冷却） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `sk_sp_down.webp` | `assets/plugin/sk_sp_down.webp` | 体力消耗（减耗） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `sk_mp_down.webp` | `assets/plugin/sk_mp_down.webp` | 法力消耗（减耗） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `sk_true.webp` | `assets/plugin/sk_true.webp` | 真实伤害（真伤） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `ex_longsword.webp` | `assets/plugin/ex_longsword.webp` | 长剑（近战·长剑） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `ex_dagger.webp` | `assets/plugin/ex_dagger.webp` | 匕首（近战·匕首） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `ex_whirl.webp` | `assets/plugin/ex_whirl.webp` | 旋风斩（近战·旋风斩） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `ex_hammer.webp` | `assets/plugin/ex_hammer.webp` | 重锤（近战·重锤） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `ex_pierce.webp` | `assets/plugin/ex_pierce.webp` | 穿甲（平射·穿甲） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `ex_rapid.webp` | `assets/plugin/ex_rapid.webp` | 连射（平射·连射） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `ex_scatter.webp` | `assets/plugin/ex_scatter.webp` | 霰弹（平射·霰弹） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `ex_snipe.webp` | `assets/plugin/ex_snipe.webp` | 狙击（平射·狙击） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `ex_fireball.webp` | `assets/plugin/ex_fireball.webp` | 火球（定点·火球） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `ex_rain.webp` | `assets/plugin/ex_rain.webp` | 箭雨（定点·箭雨） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `ex_vine.webp` | `assets/plugin/ex_vine.webp` | 藤蔓（定点·藤蔓） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `ex_curse.webp` | `assets/plugin/ex_curse.webp` | 诅咒（定点·诅咒） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `ex_bash.webp` | `assets/plugin/ex_bash.webp` | 盾突（位移·盾突） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `ex_blink.webp` | `assets/plugin/ex_blink.webp` | 瞬移（位移·瞬移） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `ex_thrust.webp` | `assets/plugin/ex_thrust.webp` | 突刺（位移·突刺） | server/data/plugins.json |
| ❌ 缺 | · 后补 | `ex_retreat.webp` | `assets/plugin/ex_retreat.webp` | 后撤（位移·后撤） | server/data/plugins.json |

## AI 积木节点（54）

| 状态 | 优先级 | 文件名（放进 assets-inbox） | 目标路径 | 名称 | 用途 |
|---|---|---|---|---|---|
| ❌ 缺 | · 后补 | `f_seq.webp` | `assets/ai/f_seq.webp` | 按顺序（流程） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `f_if.webp` | `assets/ai/f_if.webp` | 如果…否则（流程） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `a_advance.webp` | `assets/ai/a_advance.webp` | 推进（朝对手）（动作） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `a_retreat.webp` | `assets/ai/a_retreat.webp` | 后撤（远离对手）（动作） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `a_dodge_back.webp` | `assets/ai/a_dodge_back.webp` | 闪避（远离对手）（动作） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `a_defend.webp` | `assets/ai/a_defend.webp` | 防御（动作） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `a_wait.webp` | `assets/ai/a_wait.webp` | 等待（动作） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `a_skill.webp` | `assets/ai/a_skill.webp` | 释放技能（动作） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `v_number.webp` | `assets/ai/v_number.webp` | 数字（取值） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `s_my_hp.webp` | `assets/ai/s_my_hp.webp` | 我的血量（感知） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `s_my_hp_pct.webp` | `assets/ai/s_my_hp_pct.webp` | 我的血量%（感知） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `s_my_mp_pct.webp` | `assets/ai/s_my_mp_pct.webp` | 我的法力%（感知） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `s_my_sp.webp` | `assets/ai/s_my_sp.webp` | 我的体力（感知） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `s_my_cd.webp` | `assets/ai/s_my_cd.webp` | 我的技能冷却（感知） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `s_tick.webp` | `assets/ai/s_tick.webp` | 当前帧数（感知） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `s_gap.webp` | `assets/ai/s_gap.webp` | 与对手的距离（感知） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `s_foe_hp_pct.webp` | `assets/ai/s_foe_hp_pct.webp` | 对手血量%（感知） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `c_hp_below.webp` | `assets/ai/c_hp_below.webp` | 我的血量低于X%（条件） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `c_gap_less.webp` | `assets/ai/c_gap_less.webp` | 距离小于X格（条件） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `c_gap_greater.webp` | `assets/ai/c_gap_greater.webp` | 距离大于X格（条件） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `c_skill_ready.webp` | `assets/ai/c_skill_ready.webp` | 技能N已就绪（条件） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `c_random.webp` | `assets/ai/c_random.webp` | 随机X%（条件） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `c_and.webp` | `assets/ai/c_and.webp` | 且（条件） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `c_or.webp` | `assets/ai/c_or.webp` | 或（条件） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `c_not.webp` | `assets/ai/c_not.webp` | 非（条件） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `c_gap_between.webp` | `assets/ai/c_gap_between.webp` | 距离在X~Y格（条件） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `c_tick_after.webp` | `assets/ai/c_tick_after.webp` | 第X帧之后（条件） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `c_compare.webp` | `assets/ai/c_compare.webp` | 比较（条件） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `v_arith.webp` | `assets/ai/v_arith.webp` | 计算（取值） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `s_foe_sp.webp` | `assets/ai/s_foe_sp.webp` | 对手体力（感知） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `s_foe_cd.webp` | `assets/ai/s_foe_cd.webp` | 对手技能冷却（感知） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `s_my_atk.webp` | `assets/ai/s_my_atk.webp` | 我的攻击力（感知） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `s_my_def.webp` | `assets/ai/s_my_def.webp` | 我的防御力（感知） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `s_base_hp_pct.webp` | `assets/ai/s_base_hp_pct.webp` | 基地血量%（感知） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `f_loop_n.webp` | `assets/ai/f_loop_n.webp` | 重复N次（流程） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `f_loop_until.webp` | `assets/ai/f_loop_until.webp` | 重复直到…（流程） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `f_forever.webp` | `assets/ai/f_forever.webp` | 一直重复（流程） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `f_break.webp` | `assets/ai/f_break.webp` | 打断（流程） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `a_move_left.webp` | `assets/ai/a_move_left.webp` | 向左移动（动作） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `a_move_right.webp` | `assets/ai/a_move_right.webp` | 向右移动（动作） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `a_dodge_front.webp` | `assets/ai/a_dodge_front.webp` | 闪避（朝对手）（动作） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `a_turn.webp` | `assets/ai/a_turn.webp` | 转身（动作） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `m_remember.webp` | `assets/ai/m_remember.webp` | 记住（记忆） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `m_counter.webp` | `assets/ai/m_counter.webp` | 计数+1（记忆） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `m_timer.webp` | `assets/ai/m_timer.webp` | 计时器N帧（记忆） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `m_read.webp` | `assets/ai/m_read.webp` | 读取记忆（记忆） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `s_my_skill_range.webp` | `assets/ai/s_my_skill_range.webp` | 我的技能射程（感知） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `s_my_skill_type.webp` | `assets/ai/s_my_skill_type.webp` | 我的技能类型（感知） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `r_sub.webp` | `assets/ai/r_sub.webp` | 子程序（结构） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `r_call.webp` | `assets/ai/r_call.webp` | 调用子程序（结构） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `c_foe_stunned.webp` | `assets/ai/c_foe_stunned.webp` | 对手被控制（条件） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `c_has_effect.webp` | `assets/ai/c_has_effect.webp` | 我身上有效果（条件） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `s_effect_left.webp` | `assets/ai/s_effect_left.webp` | 我的效果剩余帧（感知） | server/data/ai-node-catalog.json |
| ❌ 缺 | · 后补 | `c_any_skill_ready.webp` | `assets/ai/c_any_skill_ready.webp` | 有技能就绪（条件） | server/data/ai-node-catalog.json |

## 包/宝箱（1）

| 状态 | 优先级 | 文件名（放进 assets-inbox） | 目标路径 | 名称 | 用途 |
|---|---|---|---|---|---|
| ❌ 缺 | · 后补 | `undefined.webp` | `assets/package/undefined.webp` | 角色模块包 | server/data/package-config.json |

## 界面按钮/控件（25）

| 状态 | 优先级 | 文件名（放进 assets-inbox） | 目标路径 | 名称 | 用途 |
|---|---|---|---|---|---|
| ❌ 缺 | ★ 先做 | `用户头像.webp` | `assets/ui/用户头像.webp` | 用户头像 | hub |
| ❌ 缺 | ★ 先做 | `btn_warehouse.webp` | `assets/ui/btn_warehouse.webp` | 仓库 | hub |
| ❌ 缺 | ★ 先做 | `btn_ai.webp` | `assets/ui/btn_ai.webp` | AI 编辑 | hub |
| ❌ 缺 | ★ 先做 | `btn_settings.webp` | `assets/ui/btn_settings.webp` | 设置 | hub |
| ❌ 缺 | ★ 先做 | `btn_board.webp` | `assets/ui/btn_board.webp` | 排行 | hub |
| ❌ 缺 | ★ 先做 | `btn_tournament.webp` | `assets/ui/btn_tournament.webp` | 锦标赛 | hub |
| ❌ 缺 | ★ 先做 | `btn_quick.webp` | `assets/ui/btn_quick.webp` | 快速对战 | hub |
| ❌ 缺 | ★ 先做 | `crest_role.webp` | `assets/ui/crest_role.webp` | 角色卡（不规则形状：PNG 透明底，我会描轮廓） | hub |
| ❌ 缺 | ★ 先做 | `skill_1.webp` | `assets/ui/skill_1.webp` | {skill1Name}（不规则形状：PNG 透明底，我会描轮廓） | hub |
| ❌ 缺 | ★ 先做 | `skill_2.webp` | `assets/ui/skill_2.webp` | {skill2Name}（不规则形状：PNG 透明底，我会描轮廓） | hub |
| ❌ 缺 | ★ 先做 | `skill_3.webp` | `assets/ui/skill_3.webp` | {skill3Name}（不规则形状：PNG 透明底，我会描轮廓） | hub |
| ❌ 缺 | ★ 先做 | `slot_1.webp` | `assets/ui/slot_1.webp` | 1 | hub |
| ❌ 缺 | ★ 先做 | `slot_2.webp` | `assets/ui/slot_2.webp` | 2 | hub |
| ❌ 缺 | ★ 先做 | `slot_3.webp` | `assets/ui/slot_3.webp` | 3 | hub |
| ❌ 缺 | ★ 先做 | `设为出战（将当前配置设为出战）.webp` | `assets/ui/设为出战（将当前配置设为出战）.webp` | 设为出战 | hub |
| ❌ 缺 | ★ 先做 | `对战历史.webp` | `assets/ui/对战历史.webp` | 对战历史 | hub |
| ❌ 缺 | ★ 先做 | `center_role.webp` | `assets/ui/center_role.webp` | 角色（再点一次看角色模板）（不规则形状：PNG 透明底，我会描轮廓） | modal_role_slots |
| ❌ 缺 | ★ 先做 | `slot_4.webp` | `assets/ui/slot_4.webp` | 插槽4 | modal_role_slots |
| ❌ 缺 | ★ 先做 | `slot_5.webp` | `assets/ui/slot_5.webp` | 插槽5 | modal_role_slots |
| ❌ 缺 | ★ 先做 | `slot_6.webp` | `assets/ui/slot_6.webp` | 插槽6 | modal_role_slots |
| ❌ 缺 | ★ 先做 | `pick_row1.webp` | `assets/ui/pick_row1.webp` | {rowLabel} | modal_role_pick |
| ❌ 缺 | ★ 先做 | `spick_row1.webp` | `assets/ui/spick_row1.webp` | {rowLabel} | modal_skill_pick |
| ❌ 缺 | ★ 先做 | `plug_row1.webp` | `assets/ui/plug_row1.webp` | {rowLabel} | modal_role_plugin_pick |
| ❌ 缺 | ★ 先做 | `splug_row1.webp` | `assets/ui/splug_row1.webp` | {rowLabel} | modal_skill_plugin_pick |
| ❌ 缺 | ★ 先做 | `new_1.webp` | `assets/ui/new_1.webp` | 技能2（再点一次看技能）（不规则形状：PNG 透明底，我会描轮廓） | modal_skill2_slots |

## 品质边框（5）

| 状态 | 优先级 | 文件名（放进 assets-inbox） | 目标路径 | 名称 | 用途 |
|---|---|---|---|---|---|
| ❌ 缺 | ★ 先做 | `common.svg` | `assets/frame/common.svg` | 绿 品质框 | server/data/qualities.json |
| ❌ 缺 | ★ 先做 | `rare.svg` | `assets/frame/rare.svg` | 蓝 品质框 | server/data/qualities.json |
| ❌ 缺 | ★ 先做 | `epic.svg` | `assets/frame/epic.svg` | 紫 品质框 | server/data/qualities.json |
| ❌ 缺 | ★ 先做 | `legendary.svg` | `assets/frame/legendary.svg` | 橙 品质框 | server/data/qualities.json |
| ❌ 缺 | ★ 先做 | `mythic.svg` | `assets/frame/mythic.svg` | 青 品质框 | server/data/qualities.json |

## 段位图标（5）

| 状态 | 优先级 | 文件名（放进 assets-inbox） | 目标路径 | 名称 | 用途 |
|---|---|---|---|---|---|
| ❌ 缺 | ★ 先做 | `common.svg` | `assets/tier/common.svg` | 绿 段位图标 | server/data/qualities.json |
| ❌ 缺 | ★ 先做 | `rare.svg` | `assets/tier/rare.svg` | 蓝 段位图标 | server/data/qualities.json |
| ❌ 缺 | ★ 先做 | `epic.svg` | `assets/tier/epic.svg` | 紫 段位图标 | server/data/qualities.json |
| ❌ 缺 | ★ 先做 | `legendary.svg` | `assets/tier/legendary.svg` | 橙 段位图标 | server/data/qualities.json |
| ❌ 缺 | ★ 先做 | `mythic.svg` | `assets/tier/mythic.svg` | 青 段位图标 | server/data/qualities.json |

## 音效（可选）（4）

| 状态 | 优先级 | 文件名（放进 assets-inbox） | 目标路径 | 名称 | 用途 |
|---|---|---|---|---|---|
| ➖ 可选 | · 后补 | `cast_melee.mp3` | `assets/sfx/cast_melee.mp3` | 近战 音效 | server/data/skill-templates.json |
| ➖ 可选 | · 后补 | `cast_straight.mp3` | `assets/sfx/cast_straight.mp3` | 平射 音效 | server/data/skill-templates.json |
| ➖ 可选 | · 后补 | `cast_vertical.mp3` | `assets/sfx/cast_vertical.mp3` | 定点 音效 | server/data/skill-templates.json |
| ➖ 可选 | · 后补 | `cast_displace.mp3` | `assets/sfx/cast_displace.mp3` | 位移 音效 | server/data/skill-templates.json |

