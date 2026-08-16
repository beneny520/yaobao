# 药宝 · Supabase 后端说明

单文件前端 `clay-buddy.html` + Supabase（Postgres + PostgREST RPC + Realtime）。
无自建服务器、无打包步骤：前端用 publishable/anon key 直连，所有读写都走
下面这一层受控 RPC。

## 一句话安全模型
- 8 张 `yb_` 表**全部开启 RLS 且零策略** → 匿名 key 经 PostgREST **无行可达**。
- 数据只经 `SECURITY DEFINER` RPC 出入，闸门是**家庭码 + 6 位管理 PIN 的哈希**。
- 内部函数 `yb_resolve` / `yb_snapshot` **不授予 anon EXECUTE**，防止匿名绕过 PIN
  直呼快照枚举家庭。
- **PIN 明文永不落库**：前端 WebCrypto 对 `yaobao:${familyId}:${pin}` 做 SHA-256，
  只上传哈希（家庭码当盐）。

## RPC 一览（前端可调 7 个）
| 函数 | 作用 | 需 PIN |
|---|---|---|
| `yb_get_family(code, date)` | 读当天家庭快照；不存在返回 null | 否 |
| `yb_verify_pin(code, hash)` | 校验管理 PIN | — |
| `yb_create_family(code, hash, display, elder, date, seed)` | 建家庭 + 灌 seed（宠物/药/成员/医嘱） | 建时设 |
| `yb_save_config(code, hash, payload, date)` | 保存配置；uuid→update 否则 insert，删除项做软/硬删 | 是 |
| `yb_log_dose(code, medId, taken, actor, via, date)` | 记服药/漏服，返回 `{levelUp, snapshot}` | 否 |
| `yb_add_note(code, hash, author, text, date)` | 家人留言 | 是 |
| `yb_mark_note_read(code, noteId)` | 留言标记已读（预留） | 否 |
| `yb_health_recent(code, days)` | 读近 N 天健康关心信号（AI 陪伴静默记录） | 否 |

内部：`yb_resolve(code)→uuid`、`yb_snapshot(fid, date)→jsonb`。

## AI 能力层：`yb-ai` Edge Function（F11）
唯一持有百炼 `DASHSCOPE_API_KEY` 的地方。**Key 放前端会被抓包盗刷、Token 补贴被刷光
（PRD §9.2）**，所以对话 / 拍照识别 / 语音识别全部从这一层转发。

- 部署：`verify_jwt=false` —— 不靠平台 JWT，而是自建「家庭码必须能解析到真实家庭」
  这道闸门（`sb_publishable_...` 不是 JWT，无法用平台校验）。
- 服务端注入宠物人格 + §6.3/§F11.6 安全 system prompt；对输出做诊断/指责措辞兜底过滤
  （命中 `BANNED` 词即整条替换为安全话术）。
- 用 service-role 直写 `yb_chat_turns` / `yb_health_signals`（AI 派生数据不经前端 RPC）。
- **优雅降级（F11.6）**：Key 未配置或上游失败一律返回 `200 + {ok:false,error}`，
  前端回退预置文案库，绝不 500、绝不白屏。

| op | 作用 | 上游 |
|---|---|---|
| `chat` | 宠物陪伴对话 + 确定性关键词抽健康信号 | 百炼 compatible-mode（`qwen-plus`） |
| `vision` | 药盒/处方拍照 → 结构化用药 JSON（需人工核对后生效） | `qwen-vl-plus` |
| `asr` | 音频 → 文本（Web Speech 不可用时的兜底） | `qwen3-asr-flash` |

环境变量（Supabase Dashboard → Edge Functions → Secrets 手动设置）：
`DASHSCOPE_API_KEY`（必填，未设则全系统优雅降级）、可选覆盖
`YB_CHAT_MODEL` / `YB_VL_MODEL` / `YB_ASR_MODEL`。`SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` 由平台自动注入。

> `yb_health_recent` 与 `yb-ai` 写入的 `yb_chat_turns` / `yb_health_signals` 均以
> `yb_` 前缀隔离，符合共用项目约束。

## 快照契约（`yb_snapshot` 返回）
`{ family{id,displayName,elderName,fontScale,highContrast,voiceEnabled},
selectedPetId, selectedPet{level,points,targetPoints:100,healthIndex},
streakDays, lastTakeDate(''=空), medications[], familyMembers[], medicalLogs[],
events[], notes[], weeklyHistory[] }`

- **events 是统一流**：服药流水(`type:mom_take`) + 家人留言(`type:admin_note`)，
  按时间倒序 200 条。前端 mom 视角靠 `events.filter(type==='admin_note')` 取留言，
  故两类必须并在同一数组 —— 这是跨设备联动的关键。
- `weeklyHistory` 由服务端按 `yb_dose_logs` 现算（前端不上传）。

## 成长数学（`yb_log_dose`，与 PRD §6.3 一致）
- 服药：points +25（满 100 升级、清零、`levelUp:true`）；health +10（上限 100）；
  连续天数按 `last_take_date` 递增/断签重置。
- 漏服：points −25（下限 0）；health −10，**下限 15** —— 伦理约束：宠物永不「死」。

## 实时同步：Realtime Broadcast
选 Broadcast 而非 postgres_changes —— 匿名 JWT 无家庭上下文，无法按行订阅。
频道 `family:${familyId}`（public channel，anon 可收发）。任一端写库成功后
`channel.notify()` 广播一条 `changed`；其它端收到即 `yb_get_family` 重拉快照。
前端以「单一快照应用入口 + 基于内容的配置签名」防 apply→save→apply 抖动。

## 复现
`supabase/migrations/0001_yaobao_schema.sql` 是按线上现状重建的合并快照，
可在全新 Supabase 项目一次性执行（表 / 索引 / RLS / RPC / EXECUTE 授权齐全）。
线上项目 ref：`idxzxnxfcpazdtaossna`。

> 注意：该 Supabase 项目与其它 app 共用，所有对象以 `yb_` 前缀隔离，
> 除 `yb_` 外任何东西都不得触碰。
