// 药宝 AI 代理（F11）—— 唯一持有 DASHSCOPE_API_KEY 的地方。
//
// 为什么必须有这一层（PRD §9.2）：把百炼 Key 放前端会被抓包盗刷，Token 补贴会被刷光。
// 所有 AI 调用（对话 / 拍照识别 / 语音识别）都从这里转发，并在服务端：
//   ① 注入宠物人格 + §6.3/§F11.6 安全 system prompt；
//   ② 对输出做诊断性/指责性措辞兜底过滤；
//   ③ 用 service-role 写 chat_turns / health_signals（AI 派生数据不经前端 RPC）。
//
// 优雅降级（F11.6）：Key 未配置或上游失败时，一律返回 200 + {ok:false,error:...}，
// 让前端回退到预置文案库，绝不 500、绝不白屏。
//
// 部署：verify_jwt=false —— 我们不靠平台 JWT，而是自建"家庭码必须能解析到家庭"这道闸门。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const DASHSCOPE_KEY = Deno.env.get("DASHSCOPE_API_KEY") || "";
const CHAT_MODEL = Deno.env.get("YB_CHAT_MODEL") || "qwen-plus";
const VL_MODEL = Deno.env.get("YB_VL_MODEL") || "qwen-vl-plus";
const ASR_MODEL = Deno.env.get("YB_ASR_MODEL") || "qwen3-asr-flash";

const DASHSCOPE_COMPAT = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const DASHSCOPE_MM = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// —— 安全兜底：诊断/用药指导/指责性措辞一旦出现，整条回复替换为安全话术 ——
const BANNED = [
  "疑似", "确诊", "诊断", "病情", "风险", "异常", "可能是", "很可能",
  "建议服用", "建议吃", "加大剂量", "减量", "停药", "处方", "服用剂量",
  "你怎么又忘", "怎么还没吃", "又漏", "不听话",
];
const SAFE_FALLBACK = "我在呢，陪着你。这个要问医生哦，我帮你记下来告诉你的家人好不好？";

function sanitizeReply(text: string): string {
  const t = (text || "").trim();
  if (!t) return SAFE_FALLBACK;
  for (const w of BANNED) if (t.includes(w)) return SAFE_FALLBACK;
  return t.length > 120 ? t.slice(0, 120) : t;
}

// —— 确定性健康信号抽取（不调用 LLM、零额外延迟，措辞中性，只记录+转达）——
// 只做关键词命中→记录，绝不做任何诊断/风险判定（F11.4 安全红线）。
const SIGNAL_RULES: Array<{ kind: string; words: string[] }> = [
  { kind: "sleep", words: ["睡不着", "失眠", "没睡好", "睡得浅", "睡得不好", "整夜"] },
  { kind: "appetite", words: ["没胃口", "不想吃", "吃不下", "没食欲"] },
  { kind: "complaint", words: ["头晕", "头疼", "头痛", "难受", "不舒服", "胸闷", "心慌", "乏力", "没力气", "腿疼", "肚子疼"] },
  { kind: "mood", words: ["难过", "心情不好", "闷", "孤单", "想你们", "没意思"] },
];

function extractSignals(userText: string): Array<{ kind: string; value: string }> {
  const t = userText || "";
  const out: Array<{ kind: string; value: string }> = [];
  for (const rule of SIGNAL_RULES) {
    const hit = rule.words.find((w) => t.includes(w));
    if (hit) out.push({ kind: rule.kind, value: hit });
  }
  return out;
}

function petSystemPrompt(petName: string, elderName: string): string {
  const pet = petName || "小宠物";
  const elder = elderName || "主人";
  return [
    `你是住在老人手机里的黏土小宠物「${pet}」，正在和你的主人（称呼「${elder}」）聊天。`,
    `说话风格：可爱、温暖、口语化的中文，像贴心的小家人。每次回复不超过 40 个字，最多一个 emoji。`,
    `严格红线（违反即失败）：`,
    `1. 绝不提供任何医疗建议、诊断、用药指导、剂量建议；绝不出现"疑似/风险/异常/建议服用/加大剂量/停药/处方"等词。`,
    `2. 主人说身体不舒服（头晕、难受、睡不好等）时，温柔安慰，并统一引导："这个要问医生哦，我帮你记下来告诉你的家人好不好？"，绝不自行判断病因。`,
    `3. 绝不指责主人漏服药、绝不制造焦虑，不说"你怎么又忘/怎么还没吃"这类话。`,
    `4. 你的角色只是陪伴和转达，不是医生、不是护士。`,
    `如果主人说"我吃过药了/吃了"，就开心地夸夸他并鼓励。`,
  ].join("\n");
}

async function callChat(messages: unknown[], model: string, maxTokens = 200): Promise<string> {
  const resp = await fetch(DASHSCOPE_COMPAT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${DASHSCOPE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.8 }),
  });
  if (!resp.ok) throw new Error(`upstream_${resp.status}`);
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }); }

  const op = String(body.op || "");
  const code = String(body.code || "").trim().toLowerCase();
  if (!code) return json({ ok: false, error: "missing_code" });

  // 闸门：家庭码必须能解析到一个真实家庭，才允许消耗 Token。
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: fam } = await admin.from("yb_families").select("id").eq("family_code", code).maybeSingle();
  if (!fam?.id) return json({ ok: false, error: "unknown_family" }, 403);
  const familyId = fam.id as string;

  // Key 未配置 → 优雅降级（前端走预置文案库）。
  // 但健康信号抽取是纯关键词匹配、不需要 Key —— 必须在降级路径也执行，
  // 否则老人说「我头晕」时家人端永远收不到信号（F11.4 的核心价值就没了）。
  if (!DASHSCOPE_KEY) {
    if (op === "chat") {
      const text = String(body.text || "").trim();
      const signals = text ? extractSignals(text) : [];
      if (signals.length) {
        const localDate = String(body.localDate || "").slice(0, 10) || null;
        try {
          await admin.from("yb_health_signals").insert(
            signals.map((s) => ({
              family_id: familyId, kind: s.kind, value: s.value,
              raw_text: text, local_date: localDate,
            })),
          );
        } catch (_) { /* 信号记录失败不影响降级回复 */ }
      }
      // careHint 告诉前端：这次听出了身体不适，该用「引导就医」话术而不是随机暖心话
      return json({
        ok: false, error: "ai_not_configured",
        signals: signals.map((s) => s.kind),
        careHint: signals.some((s) => s.kind === "complaint") ? "seek_care" : null,
      });
    }
    return json({ ok: false, error: "ai_not_configured" });
  }

  try {
    if (op === "chat") {
      const text = String(body.text || "").trim();
      if (!text) return json({ ok: false, error: "empty_text" });
      const petName = String(body.petName || "");
      const elderName = String(body.elderName || "");
      const audioMs = Number(body.audioMs || 0) || null;

      const raw = await callChat([
        { role: "system", content: petSystemPrompt(petName, elderName) },
        { role: "user", content: text },
      ], CHAT_MODEL);
      const reply = sanitizeReply(raw);

      // 写对话流水（service-role，AI 派生数据不经前端 RPC）
      await admin.from("yb_chat_turns").insert([
        { family_id: familyId, role: "user", text, audio_ms: audioMs },
        { family_id: familyId, role: "pet", text: reply },
      ]);

      // 静默健康信号 → 家人端（确定性关键词，措辞中性）
      const signals = extractSignals(text);
      if (signals.length) {
        const localDate = String(body.localDate || "").slice(0, 10) || null;
        await admin.from("yb_health_signals").insert(
          signals.map((s) => ({
            family_id: familyId, kind: s.kind, value: s.value,
            raw_text: text, local_date: localDate,
          })),
        );
      }
      return json({ ok: true, reply, signals: signals.map((s) => s.kind) });
    }

    if (op === "vision") {
      const image = String(body.imageBase64 || "");
      if (!image) return json({ ok: false, error: "empty_image" });
      const dataUri = image.startsWith("data:") ? image : `data:image/jpeg;base64,${image}`;
      const raw = await callChat([
        {
          role: "system",
          content:
            "你是药品信息识别助手。从药盒/说明书/处方照片中提取用药信息，只输出 JSON，不要多余文字。" +
            "格式：{\"meds\":[{\"name\":药名,\"dose\":单次剂量如'1片',\"times\":[\"08:00\"]或[],\"notes\":用法注意}]}。" +
            "识别不清的字段留空字符串或空数组，绝不编造。不做任何医疗建议。",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "请识别这张照片里的药品信息，只回 JSON。" },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        },
      ], VL_MODEL, 700);

      let meds: unknown[] = [];
      try {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) meds = JSON.parse(m[0])?.meds ?? [];
      } catch { meds = []; }
      return json({ ok: true, meds });
    }

    if (op === "asr") {
      const audio = String(body.audioBase64 || "");
      if (!audio) return json({ ok: false, error: "empty_audio" });
      const fmt = String(body.format || "wav");
      const mime = fmt === "mp3" ? "audio/mpeg" : `audio/${fmt}`;
      const dataUri = audio.startsWith("data:") ? audio : `data:${mime};base64,${audio}`;

      // 候选 [模型, 是否OpenAI式嵌套格式(input_audio.data)]，同一 multimodal-generation 端点。
      // 主选 fun-asr-flash-2026-06-15（非实时HTTP、base64、多方言，用户后台可见可用，官方当前推荐）；
      // 兜底 ASR_MODEL(qwen3-asr-flash，flat audio 格式)。env YB_ASR_MODELS 可覆盖（逗号分隔）。
      const defaultList: Array<[string, boolean]> = [
        ["fun-asr-flash-2026-06-15", true],
        [ASR_MODEL, ASR_MODEL.startsWith("fun-asr") || ASR_MODEL.includes("qwen-audio")],
      ];
      const envRaw = (Deno.env.get("YB_ASR_MODELS") || "").split(",").map((s) => s.trim()).filter(Boolean);
      const list: Array<[string, boolean]> = envRaw.length
        ? envRaw.map((m) => [m, m.startsWith("fun-asr") || m.includes("qwen-audio")])
        : defaultList;

      const pickText = (d: any): string => {
        const t = d?.output?.text; // fun-asr-flash / fun-asr-realtime
        if (typeof t === "string" && t.trim()) return t.trim();
        const c = d?.output?.choices?.[0]?.message?.content ?? d?.choices?.[0]?.message?.content; // qwen-asr / OpenAI 兼容
        if (Array.isArray(c)) return c.map((x: any) => x?.text || "").join("").trim();
        if (typeof c === "string") return c.trim();
        return "";
      };

      const errs: string[] = [];
      for (const [m, nested] of list) {
        try {
          const content = nested
            ? [{ type: "input_audio", input_audio: { data: dataUri } }]
            : [{ audio: dataUri }];
          const resp = await fetch(DASHSCOPE_MM, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${DASHSCOPE_KEY}`,
              "Content-Type": "application/json",
              "X-DashScope-SSE": "disable",
            },
            body: JSON.stringify({
              model: m,
              input: { messages: [{ role: "user", content }] },
              parameters: { format: fmt },
            }),
          });
          if (!resp.ok) {
            const detail = await resp.text().catch(() => "");
            errs.push(`${m}->HTTP${resp.status}:${detail.slice(0, 200)}`);
            continue;
          }
          const data = await resp.json();
          // 关键：百炼常 HTTP 200 但 body 是 {code,message} 应用层错误（老代码会吞掉误报 ok:true）。
          // 成功响应无 code 字段；有 code 即视为失败，继续试下一个模型。
          if (data?.code && String(data.code) !== "0") {
            errs.push(`${m}->APP:${data.code}:${String(data?.message || "").slice(0, 200)}`);
            continue;
          }
          return json({ ok: true, text: pickText(data), model: m, _diag: errs.length ? errs : undefined });
        } catch (e) {
          errs.push(`${m}->throw:${String((e as Error)?.message || e).slice(0, 120)}`);
        }
      }
      return json({ ok: false, error: "asr_upstream", detail: errs.join(" || "), _diag: errs });
    }

    return json({ ok: false, error: "unknown_op" });
  } catch (e) {
    // 任何上游异常都降级为 ok:false，前端回退预置文案。
    return json({ ok: false, error: "ai_upstream_failed", detail: String((e as Error)?.message || e) });
  }
});
