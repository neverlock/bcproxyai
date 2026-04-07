import { NextRequest } from "next/server";
import { getDb } from "@/lib/db/schema";
import { getNextApiKey, markKeyCooldown } from "@/lib/api-keys";
import { PROVIDER_URLS } from "@/lib/providers";
import { clearCache } from "@/lib/cache";
import { compressMessages } from "@/lib/prompt-compress";
import { openAIError, ensureChatCompletionFields } from "@/lib/openai-compat";
import { autoDetectComplaint } from "@/lib/auto-complaint";
import { getReputationScore } from "@/lib/worker/complaint";
import { detectPromptCategory, recordRoutingResult, getBestModelsForCategory, getBestModelsByBenchmarkCategory, emitEvent } from "@/lib/routing-learn";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Budget check: returns { ok, percentUsed } — blocks at 95%
function checkBudget(): { ok: boolean; preferCheap: boolean; percentUsed: number } {
  try {
    const db = getDb();
    const configRow = db.prepare("SELECT value FROM budget_config WHERE key = 'daily_token_limit'").get() as { value: string } | undefined;
    const dailyLimit = configRow ? Number(configRow.value) : 1000000;

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const usage = db.prepare(
      "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total FROM token_usage WHERE created_at >= ?"
    ).get(`${today}T00:00:00`) as { total: number };

    const percentUsed = dailyLimit > 0 ? (usage.total / dailyLimit) * 100 : 0;
    return {
      ok: percentUsed < 95,
      preferCheap: percentUsed >= 80,
      percentUsed,
    };
  } catch {
    return { ok: true, preferCheap: false, percentUsed: 0 };
  }
}

// Track token usage after a successful response
function trackTokenUsage(provider: string, modelId: string, inputTokens: number, outputTokens: number) {
  try {
    const db = getDb();
    db.prepare(
      "INSERT INTO token_usage (provider, model_id, input_tokens, output_tokens, estimated_cost_usd) VALUES (?, ?, ?, ?, 0)"
    ).run(provider, modelId, inputTokens, outputTokens);
  } catch {
    // non-critical
  }
}

interface ModelRow {
  id: string;
  provider: string;
  model_id: string;
  supports_tools: number;
  supports_vision: number;
  tier: string;
  context_length: number;
  avg_score: number | null;
  avg_latency: number | null;
  health_status: string | null;
  cooldown_until: string | null;
}

// ─── In-Memory Provider Cooldown ───
// ไม่ต้องเขียน health_logs ทุก model → ใช้ Map ในเมมเร็วกว่า ไม่ bloat DB
const providerCooldowns = new Map<string, { until: number; reason: string }>();

function isProviderCooledDown(provider: string): boolean {
  const cd = providerCooldowns.get(provider);
  if (!cd) return false;
  if (Date.now() > cd.until) {
    providerCooldowns.delete(provider);
    return false;
  }
  return true;
}

function setProviderCooldown(provider: string, ms: number, reason: string) {
  providerCooldowns.set(provider, { until: Date.now() + ms, reason });
  console.log(`[COOLDOWN] ${provider} → ${Math.round(ms / 60000)}min | ${reason}`);
}

interface RequestCapabilities {
  hasTools: boolean;
  hasImages: boolean;
  needsJsonSchema: boolean;
}

function detectRequestCapabilities(body: Record<string, unknown>): RequestCapabilities {
  const hasTools = Array.isArray(body.tools) && (body.tools as unknown[]).length > 0;

  // Check if any message contains image_url content
  const messages = (body.messages as Array<{ role: string; content: unknown }>) || [];
  let hasImages = false;
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content as Array<{ type: string }>) {
        if (part.type === "image_url") {
          hasImages = true;
          break;
        }
      }
    }
    if (hasImages) break;
  }

  // Check for json_schema response_format
  const responseFormat = body.response_format as { type?: string; json_schema?: unknown } | undefined;
  const needsJsonSchema =
    responseFormat?.type === "json_schema" && responseFormat?.json_schema != null;

  return { hasTools, hasImages, needsJsonSchema };
}

// Rough token estimate: ~4 chars per token for English, ~2 for Thai/CJK
function estimateTokens(body: Record<string, unknown>): number {
  const str = JSON.stringify(body.messages ?? []);
  // Mix of Thai + English → ~3 chars per token average
  return Math.ceil(str.length / 3);
}

// Providers known to reliably support vision through OpenAI-compatible API
const VISION_PRIORITY_PROVIDERS = ["google", "groq", "ollama", "github"];

function getAvailableModels(caps: RequestCapabilities, benchmarkCategory?: string): ModelRow[] {
  // No cache — SQLite query < 1ms, cache causes Ollama priority issues

  const db = getDb();
  const now = new Date().toISOString();

  const filters: string[] = [
    // Simple: model is available if no cooldown or cooldown expired
    "(h.cooldown_until IS NULL OR h.cooldown_until < ?)",
    // Exclude non-chat models (embedding, TTS, image-gen only)
    "COALESCE(m.supports_embedding, 0) != 1",
    "COALESCE(m.supports_audio_output, 0) != 1",
    "COALESCE(m.supports_image_gen, 0) != 1",
  ];
  if (caps.hasImages) filters.push("m.supports_vision = 1");

  const whereClause = filters.join(" AND ");

  // Use category-specific benchmark score when available
  const benchmarkJoin = benchmarkCategory
    ? `LEFT JOIN (
        SELECT model_id, AVG(score) as avg_score, AVG(latency_ms) as avg_latency
        FROM benchmark_results WHERE category = '${benchmarkCategory}'
        GROUP BY model_id
      ) bcat ON m.id = bcat.model_id
      LEFT JOIN (
        SELECT model_id, AVG(score) as avg_score_all, AVG(latency_ms) as avg_latency_all
        FROM benchmark_results
        GROUP BY model_id
      ) ball ON m.id = ball.model_id`
    : `LEFT JOIN (
        SELECT model_id, AVG(score) as avg_score_all, AVG(latency_ms) as avg_latency_all
        FROM benchmark_results
        GROUP BY model_id
      ) ball ON m.id = ball.model_id`;

  // Score: prefer category-specific score, fallback to overall
  const scoreExpr = benchmarkCategory
    ? "COALESCE(bcat.avg_score, ball.avg_score_all, 0)"
    : "COALESCE(ball.avg_score_all, 0)";
  const latencyExpr = benchmarkCategory
    ? "COALESCE(bcat.avg_latency, ball.avg_latency_all, 9999999)"
    : "COALESCE(ball.avg_latency_all, 9999999)";

  // Vision requests: boost providers known to work with images
  const visionBoost = caps.hasImages
    ? `, CASE WHEN m.provider IN ('google','groq','ollama','github') THEN 0 ELSE 1 END as vision_priority`
    : "";
  const visionOrder = caps.hasImages ? "vision_priority ASC," : "";

  // Tools requests: prefer models that support tools + large context (OpenClaw sends 50-100 messages)
  const toolsBoost = caps.hasTools
    ? "CASE WHEN m.supports_tools = 1 THEN 0 ELSE 1 END ASC, CASE WHEN m.context_length >= 128000 THEN 0 WHEN m.context_length >= 32000 THEN 1 ELSE 2 END ASC,"
    : "";

  const orderClause = caps.needsJsonSchema
    ? `${toolsBoost} ${visionOrder} CASE WHEN m.tier = 'large' THEN 0 ELSE 1 END ASC, CASE WHEN ${scoreExpr} > 0 THEN 0 ELSE 1 END ASC, ${scoreExpr} DESC, m.context_length DESC, ${latencyExpr} ASC`
    : `${toolsBoost} ${visionOrder} CASE WHEN ${scoreExpr} > 0 THEN 0 ELSE 1 END ASC, ${scoreExpr} DESC, m.context_length DESC, ${latencyExpr} ASC`;

  const rows = db
    .prepare(
      `
      SELECT
        m.id,
        m.provider,
        m.model_id,
        m.supports_tools,
        m.supports_vision,
        m.tier,
        m.context_length,
        ${scoreExpr} as avg_score,
        ${latencyExpr} as avg_latency,
        h.status as health_status,
        h.cooldown_until
        ${visionBoost}
      FROM models m
      ${benchmarkJoin}
      LEFT JOIN (
        SELECT hl.model_id, hl.status, hl.cooldown_until
        FROM health_logs hl
        INNER JOIN (
          SELECT model_id, MAX(id) as max_id
          FROM health_logs
          GROUP BY model_id
        ) latest ON hl.model_id = latest.model_id AND hl.id = latest.max_id
      ) h ON m.id = h.model_id
      WHERE ${whereClause}
      ORDER BY ${orderClause}
    `
    )
    .all(now) as ModelRow[];

  // DEBUG: log query results
  const providerCount: Record<string, number> = {};
  for (const r of rows) providerCount[r.provider] = (providerCount[r.provider] || 0) + 1;
  console.log(`[DEBUG] mode=auto candidates=${rows.length} providers=${JSON.stringify(providerCount)}`);
  if (rows.length > 0) {
    const top3 = rows.slice(0, 3).map(r => `${r.provider}/${r.model_id}`);
    console.log(`[DEBUG] after boost: candidates=${rows.length} top3=[${top3}]`);
  }

  return rows;
}

function logGateway(
  requestModel: string,
  resolvedModel: string | null,
  provider: string | null,
  status: number,
  latencyMs: number,
  inputTokens: number,
  outputTokens: number,
  error: string | null,
  userMessage: string | null,
  assistantMessage: string | null
) {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO gateway_logs (request_model, resolved_model, provider, status, latency_ms, input_tokens, output_tokens, error, user_message, assistant_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      requestModel,
      resolvedModel,
      provider,
      status,
      latencyMs,
      inputTokens,
      outputTokens,
      error,
      userMessage?.slice(0, 500) ?? null,
      assistantMessage?.slice(0, 500) ?? null
    );
  } catch {
    // non-critical
  }
}

function extractUserMessage(body: Record<string, unknown>): string | null {
  const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
  if (!messages || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (typeof last.content === "string") return last.content.slice(0, 500);
  if (Array.isArray(last.content)) {
    return (last.content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("")
      .slice(0, 500) || null;
  }
  return JSON.stringify(last.content).slice(0, 500);
}

function logCooldown(modelId: string, errorMsg: string, httpStatus = 0, overrideMinutes?: number) {
  try {
    const db = getDb();
    // Cooldown เฉพาะ model — สั้นๆ พอให้ลองใหม่ได้เร็ว
    let cooldownMs: number;
    if (overrideMinutes !== undefined) {
      cooldownMs = overrideMinutes * 60 * 1000;
    } else if (httpStatus === 429) {
      cooldownMs = 2 * 60 * 1000;     // 2 นาที — rate limit
    } else if (httpStatus === 410) {
      cooldownMs = 24 * 60 * 60 * 1000; // 24 ชม. — model ถูกถอด (Gone)
    } else if (httpStatus === 401 || httpStatus === 403) {
      cooldownMs = 60 * 60 * 1000;    // 1 ชม. — auth error
    } else if (httpStatus >= 500) {
      cooldownMs = 5 * 60 * 1000;     // 5 นาที — server error
    } else {
      cooldownMs = 1 * 60 * 1000;     // 1 นาที — default (400, 413, 422)
    }
    const cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
    db.prepare(
      `INSERT INTO health_logs (model_id, status, error, cooldown_until, checked_at)
       VALUES (?, 'available', ?, ?, datetime('now'))`
    ).run(modelId, errorMsg, cooldownUntil);
    // Clear model cache so next request gets fresh data
    clearCache("models:");
    clearCache("allmodels:");
  } catch {
    // non-critical
  }
}

function cooldownProvider(provider: string, httpStatus: number, errorMsg: string) {
  // In-memory provider cooldown — ไม่ bloat health_logs DB
  let cooldownMs: number;
  if (httpStatus === 429) {
    cooldownMs = 5 * 60 * 1000;        // 5 นาที — rate limit
  } else if (httpStatus === 401 || httpStatus === 403) {
    cooldownMs = 60 * 60 * 1000;       // 1 ชม. — auth error
  } else {
    cooldownMs = 5 * 60 * 1000;        // 5 นาที — default
  }
  setProviderCooldown(provider, cooldownMs, `HTTP ${httpStatus}: ${errorMsg}`);
}

function parseModelField(model: string): {
  mode: "auto" | "fast" | "tools" | "thai" | "consensus" | "direct" | "match";
  provider?: string;
  modelId?: string;
} {
  if (!model || model === "auto" || model === "bcproxy/auto") {
    return { mode: "auto" };
  }
  if (model === "bcproxy/fast") return { mode: "fast" };
  if (model === "bcproxy/tools") return { mode: "tools" };
  if (model === "bcproxy/thai") return { mode: "thai" };
  if (model === "bcproxy/consensus") return { mode: "consensus" };

  // openrouter/xxx, kilo/xxx, groq/xxx
  const providerMatch = model.match(/^(openrouter|kilo|google|groq|cerebras|sambanova|mistral|ollama|github|fireworks|cohere|cloudflare|huggingface)\/(.+)$/);
  if (providerMatch) {
    return { mode: "direct", provider: providerMatch[1], modelId: providerMatch[2] };
  }

  return { mode: "match", modelId: model };
}

// Last resort: get ALL models including cooldown ones — better than 503
function getAllModelsIncludingCooldown(caps: RequestCapabilities): ModelRow[] {
  const db = getDb();
  const filters: string[] = [
    "m.context_length >= 32000",
    "COALESCE(m.supports_embedding, 0) != 1",
    "COALESCE(m.supports_audio_output, 0) != 1",
    "COALESCE(m.supports_image_gen, 0) != 1",
  ];
  if (caps.hasImages) filters.push("m.supports_vision = 1");
  const whereClause = filters.join(" AND ");

  // For vision: prioritize known-good providers, then random
  const orderClause = caps.hasImages
    ? "CASE WHEN m.provider IN ('google','groq','ollama') THEN 0 ELSE 1 END ASC, RANDOM()"
    : "RANDOM()";

  const result = db.prepare(`
    SELECT m.id, m.provider, m.model_id, m.supports_tools, m.supports_vision, m.tier, m.context_length,
      COALESCE(b.avg_score, 0) as avg_score, COALESCE(b.avg_latency, 9999999) as avg_latency
    FROM models m
    LEFT JOIN (SELECT model_id, AVG(score) as avg_score, AVG(latency_ms) as avg_latency FROM benchmark_results GROUP BY model_id) b ON m.id = b.model_id
    WHERE ${whereClause}
    ORDER BY ${orderClause}
    LIMIT 20
  `).all() as ModelRow[];

  return result;
}

function selectModelsByMode(
  mode: string,
  caps: RequestCapabilities,
  benchmarkCategory?: string
): ModelRow[] {
  const db = getDb();
  const now = new Date().toISOString();

  if (mode === "fast") {
    // fastest = lowest latency, still apply capability filters
    const filters: string[] = [
      "(h.cooldown_until IS NULL OR h.cooldown_until < ?)",
      "COALESCE(m.supports_embedding, 0) != 1",
      "COALESCE(m.supports_audio_output, 0) != 1",
      "COALESCE(m.supports_image_gen, 0) != 1",
    ];
    if (caps.hasImages) filters.push("m.supports_vision = 1");
    const whereClause = filters.join(" AND ");

    const rows = db
      .prepare(
        `
        SELECT
          m.id, m.provider, m.model_id, m.supports_tools, m.supports_vision, m.tier, m.context_length,
          COALESCE(b.avg_score, 0) as avg_score,
          COALESCE(b.avg_latency, 9999999) as avg_latency,
          h.status as health_status,
          h.cooldown_until
        FROM models m
        LEFT JOIN (
          SELECT model_id, AVG(score) as avg_score, AVG(latency_ms) as avg_latency
          FROM benchmark_results GROUP BY model_id
        ) b ON m.id = b.model_id
        LEFT JOIN (
          SELECT hl.model_id, hl.status, hl.cooldown_until
          FROM health_logs hl
          INNER JOIN (
            SELECT model_id, MAX(checked_at) as max_checked FROM health_logs GROUP BY model_id
          ) latest ON hl.model_id = latest.model_id AND hl.checked_at = latest.max_checked
        ) h ON m.id = h.model_id
        WHERE ${whereClause}
        ORDER BY avg_latency ASC, avg_score DESC
      `
      )
      .all(now) as ModelRow[];
    return rows;
  }

  if (mode === "tools") {
    return getAvailableModels({ ...caps, hasTools: true }, benchmarkCategory);
  }

  // auto / thai → no context filter, let provider handle 413
  return getAvailableModels(caps, benchmarkCategory);
}

async function forwardToProvider(
  provider: string,
  actualModelId: string,
  body: Record<string, unknown>,
  stream: boolean
): Promise<Response> {
  const url = PROVIDER_URLS[provider];
  if (!url) throw new Error(`Unknown provider: ${provider}`);

  const apiKey = getNextApiKey(provider);
  if (!apiKey) throw new Error(`No API key for provider: ${provider}`);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  // OpenRouter requires extra headers
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://bcproxy.ai";
    headers["X-Title"] = "BCProxyAI Gateway";
  }

  const requestBody: Record<string, unknown> = { ...body, model: actualModelId };

  // Strip OpenClaw-specific params that most providers reject
  delete requestBody.store;           // OpenAI-only param
  delete requestBody.stream_options;  // Not widely supported
  // max_completion_tokens → max_tokens for non-OpenAI providers
  if (requestBody.max_completion_tokens && !requestBody.max_tokens) {
    requestBody.max_tokens = requestBody.max_completion_tokens;
    delete requestBody.max_completion_tokens;
  }

  // Normalize messages — strip extra fields and fix tool_call format
  // OpenClaw sends "reasoning" field and tool_calls with empty "type" field,
  // both of which Mistral/Groq reject with 422/400
  if (Array.isArray(requestBody.messages)) {
    for (const msg of requestBody.messages as Array<Record<string, unknown>>) {
      // Strip reasoning fields (Mistral/Groq don't support)
      if (msg.reasoning !== undefined) delete msg.reasoning;
      if (msg.reasoning_content !== undefined) delete msg.reasoning_content;

      // Force tool_calls[].type = "function" — OpenClaw sends "" which all providers reject
      if (Array.isArray(msg.tool_calls)) {
        const tcs = msg.tool_calls as Array<Record<string, unknown>>;
        if (tcs.length === 0) {
          // Empty tool_calls array → remove it (Mistral rejects assistant with empty tool_calls + null content)
          delete msg.tool_calls;
        } else {
          for (const tc of tcs) {
            if (tc.type !== "function") tc.type = "function";
          }
          // Assistant with tool_calls should have content: null (not "")
          if (msg.content === "") msg.content = null;
        }
      }

      // Mistral rule: assistant message must have content OR tool_calls (not neither)
      if (msg.role === "assistant" && !msg.tool_calls) {
        if (msg.content === null || msg.content === undefined || msg.content === "") {
          msg.content = " "; // single space — satisfies "must have content"
        }
      }
    }
  }

  // Mistral: fix tool_call_id format (must be exactly 9 alphanumeric chars)
  // OpenClaw sends "exec1774786568428215" → Mistral rejects with 422
  if (provider === "mistral" && Array.isArray(requestBody.messages)) {
    const idMap = new Map<string, string>(); // old → new mapping
    let counter = 0;
    const msgs = requestBody.messages as Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string }>;
    for (const msg of msgs) {
      // Fix assistant tool_calls[].id
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id && (tc.id.length !== 9 || !/^[a-zA-Z0-9]+$/.test(tc.id))) {
            if (!idMap.has(tc.id)) {
              idMap.set(tc.id, `tc${String(counter++).padStart(7, "0")}`);
            }
            tc.id = idMap.get(tc.id)!;
          }
        }
      }
      // Fix tool result tool_call_id
      if (msg.role === "tool" && msg.tool_call_id) {
        if (idMap.has(msg.tool_call_id)) {
          msg.tool_call_id = idMap.get(msg.tool_call_id)!;
        } else if (msg.tool_call_id.length !== 9 || !/^[a-zA-Z0-9]+$/.test(msg.tool_call_id)) {
          const newId = `tc${String(counter++).padStart(7, "0")}`;
          idMap.set(msg.tool_call_id, newId);
          msg.tool_call_id = newId;
        }
      }
    }
    if (idMap.size > 0) {
      console.log(`[FWD] Fixed ${idMap.size} tool_call_ids for Mistral compatibility`);
    }
    // Cap max_tokens for Mistral (some models have lower limits)
    if (requestBody.max_tokens && (requestBody.max_tokens as number) > 16384) {
      requestBody.max_tokens = 16384;
    }
  }

  // Ollama: convert image URLs to base64 (Ollama doesn't support image URLs)
  if (provider === "ollama" && Array.isArray(requestBody.messages)) {
    const msgs = requestBody.messages as Array<{ role: string; content: unknown }>;
    for (const msg of msgs) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content as Array<{ type: string; image_url?: { url?: string } }>) {
          if (part.type === "image_url" && part.image_url?.url && !part.image_url.url.startsWith("data:")) {
            try {
              const imgRes = await fetch(part.image_url.url, { signal: AbortSignal.timeout(10000) });
              if (imgRes.ok) {
                const buf = Buffer.from(await imgRes.arrayBuffer());
                const mime = imgRes.headers.get("content-type") || "image/jpeg";
                part.image_url.url = `data:${mime};base64,${buf.toString("base64")}`;
              }
            } catch { /* keep original URL, let provider handle error */ }
          }
        }
      }
    }
  }

  // Compress messages if they are large (> 30K estimated tokens)
  if (Array.isArray(requestBody.messages)) {
    const compressed = compressMessages(requestBody.messages as { role: string; content: unknown }[]);
    if (compressed.compressed) {
      requestBody.messages = compressed.messages;
      console.log(`[Gateway] Compressed: saved ${compressed.savedChars} chars (~${Math.round(compressed.savedChars / 3)} tokens)`);
    }
  }

  // Strip tools if model doesn't support them OR if request has images
  // Many providers reject tools + images together
  const hasImagesInReq = Array.isArray(requestBody.messages) && (requestBody.messages as Array<{content: unknown}>).some(
    m => Array.isArray(m.content) && (m.content as Array<{type: string}>).some(p => p.type === "image_url")
  );
  // Strip tools when needed (images or model doesn't support)
  let toolsStripped = false;
  if (hasImagesInReq && requestBody.tools) {
    console.log(`[FWD] Stripping tools (images+tools incompatible) for ${provider}/${actualModelId}`);
    delete requestBody.tools;
    delete requestBody.tool_choice;
    toolsStripped = true;
  }
  if (!toolsStripped) {
    try {
      const db = getDb();
      const row = db.prepare("SELECT supports_tools FROM models WHERE provider = ? AND model_id = ?").get(provider, actualModelId) as { supports_tools: number } | undefined;
      if (row && row.supports_tools !== 1 && requestBody.tools) {
        console.log(`[FWD] Stripping tools (supports_tools=${row.supports_tools}) for ${provider}/${actualModelId}`);
        delete requestBody.tools;
        delete requestBody.tool_choice;
        toolsStripped = true;
      }
    } catch { /* non-critical */ }
  }

  // When tools are stripped, also clean tool-related messages from history
  // Providers reject orphaned role="tool" messages when tools field is absent
  if (toolsStripped && Array.isArray(requestBody.messages)) {
    const msgs = requestBody.messages as Array<{ role: string; tool_calls?: unknown; tool_call_id?: string }>;
    requestBody.messages = msgs.filter(m => {
      if (m.role === "tool") return false; // remove tool result messages
      if (m.role === "assistant" && m.tool_calls) {
        delete m.tool_calls; // keep assistant message but remove tool_calls
      }
      return true;
    });
    console.log(`[FWD] Cleaned tool messages: ${msgs.length} → ${(requestBody.messages as unknown[]).length} msgs`);
  }

  // Ollama: set large context window via options.num_ctx
  if (provider === "ollama") {
    requestBody.options = { ...(requestBody.options as Record<string, unknown> ?? {}), num_ctx: 65536 };
  }

  // Timeout: 15s for cloud, 60s for Ollama (local, slower)
  const timeoutMs = provider === "ollama" ? 60000 : 15000;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(timeoutMs),
  });

  // On 429, mark this key as rate-limited and cooldown 5 minutes
  if (response.status === 429) {
    markKeyCooldown(provider, apiKey, 300000);
    // Return a new response with the body text so caller can read it
    const text = await response.text();
    return new Response(text, { status: 429, headers: response.headers });
  }

  return response;
}

function isRetryableStatus(status: number): boolean {
  return status === 413 || status === 429 || status === 410 || status >= 500;
}

// ตรวจ response quality — ตรวจจับ tool_call XML leak, empty response, <think> tags
const XML_TOOL_CALL_RE = /<tool_call>|<functioncall>|<function_calls>/i;
const THINK_TAG_RE = /<think>[\s\S]*?<\/think>/g;

function isResponseBad(content: string, hadTools: boolean): string | null {
  if (!content && hadTools) return null; // empty content OK if tool_calls present
  if (hadTools && XML_TOOL_CALL_RE.test(content)) {
    return "tool_call XML leak";
  }
  if (content.length > 0 && content.length < 3) {
    return "response too short";
  }
  return null;
}

function cleanResponseContent(content: string): string {
  // Strip <think> blocks from reasoning models
  return content.replace(THINK_TAG_RE, "").trim();
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    // DEBUG: log full request structure (remove after debugging)
    const debugKeys = Object.keys(body);
    const toolCount = Array.isArray(body.tools) ? (body.tools as unknown[]).length : 0;
    const msgCount = Array.isArray(body.messages) ? (body.messages as unknown[]).length : 0;
    console.log(`[DEBUG] keys=[${debugKeys}] msgs=${msgCount} tools=${toolCount} stream=${body.stream}`);

    // Validate request body
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return openAIError(400, { message: "messages is required and must be a non-empty array", param: "messages" });
    }
    if (typeof body.model !== "string" && body.model !== undefined) {
      return openAIError(400, { message: "model must be a string", param: "model" });
    }

    const modelField = (body.model as string) || "auto";
    const isStream = body.stream === true;
    const caps = detectRequestCapabilities(body);
    const _reqTime = Date.now();
    const _reqMsg = extractUserMessage(body)?.slice(0, 80) ?? "-";
    console.log(`[REQ] ${modelField} | stream=${isStream} | img=${caps.hasImages} | tools=${caps.hasTools} | "${_reqMsg}"`);

    // Budget check — block at 95%
    const budget = checkBudget();
    if (!budget.ok) {
      return openAIError(429, {
        message: `Daily budget exceeded (${budget.percentUsed.toFixed(1)}% used). Try again tomorrow or increase limit via /api/budget`,
        code: "rate_limit_exceeded",
      });
    }

    const parsed = parseModelField(modelField);

    // If budget >= 80%, prefer fast/cheap mode
    if (budget.preferCheap && parsed.mode === "auto") {
      parsed.mode = "fast" as typeof parsed.mode;
    }

    const estInputTokens = estimateTokens(body);
    const promptCategory = detectPromptCategory(extractUserMessage(body) ?? "");

    // ---- Consensus mode: send to 3 providers, pick best answer ----
    if (parsed.mode === "consensus") {
      const userMsg = extractUserMessage(body);
      const consensusStart = Date.now();

      // Get top 3 models from different providers
      const allModels = getAvailableModels(caps);
      const picked: ModelRow[] = [];
      const usedProviders = new Set<string>();
      for (const m of allModels) {
        if (!usedProviders.has(m.provider) && picked.length < 3) {
          picked.push(m);
          usedProviders.add(m.provider);
        }
      }

      if (picked.length > 0) {
        // Force non-streaming for consensus (need full response to compare)
        const consensusBody = { ...body, stream: false };

        const results = await Promise.all(
          picked.map(async (m) => {
            const start = Date.now();
            try {
              const res = await forwardToProvider(m.provider, m.model_id, consensusBody, false);
              if (!res.ok) return null;
              const json = await res.json();
              const content = (json as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
              return { model: m, content, latency: Date.now() - start, json };
            } catch {
              return null;
            }
          })
        );

        // Pick best: longest content, then lowest latency
        const valid = results.filter(
          (r): r is NonNullable<typeof r> => r != null && r.content.length > 0
        );

        if (valid.length > 0) {
          valid.sort((a, b) => {
            if (b.content.length !== a.content.length) return b.content.length - a.content.length;
            return a.latency - b.latency;
          });

          const best = valid[0];
          const totalLatency = Date.now() - consensusStart;

          // Track token usage for winning model
          const usage = (best.json as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
          if (usage) {
            trackTokenUsage(best.model.provider, best.model.model_id, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);
          }

          logGateway(
            "bcproxy/consensus",
            best.model.model_id,
            best.model.provider,
            200,
            totalLatency,
            usage?.prompt_tokens ?? 0,
            usage?.completion_tokens ?? 0,
            null,
            userMsg,
            `[consensus: ${valid.map((v) => v.model.provider + "/" + v.model.model_id).join(", ")}] ${best.content.slice(0, 300)}`
          );

          const headers = new Headers();
          headers.set("Content-Type", "application/json");
          headers.set("X-BCProxy-Provider", best.model.provider);
          headers.set("X-BCProxy-Model", best.model.model_id);
          headers.set(
            "X-BCProxy-Consensus",
            valid.map((v) => `${v.model.provider}/${v.model.model_id}(${v.content.length}chars/${v.latency}ms)`).join(", ")
          );
          headers.set("Access-Control-Allow-Origin", "*");

          return new Response(JSON.stringify(best.json), { status: 200, headers });
        }
      }

      // Fallback: no consensus candidates or all failed → fall through to normal auto routing
      parsed.mode = "auto" as typeof parsed.mode;
    }

    // ---- Direct provider routing (openrouter/xxx, kilo/xxx, groq/xxx) ----
    if (parsed.mode === "direct") {
      const { provider, modelId } = parsed;
      const response = await forwardToProvider(provider!, modelId!, body, isStream);

      if (!response.ok && isRetryableStatus(response.status)) {
        const errText = await response.text();
        return openAIError(response.status, { message: errText || `Provider ${provider} returned ${response.status}` });
      }

      console.log(`[RES] ${response.status} | ${provider}/${modelId} | ${Date.now() - _reqTime}ms | direct`);
      return buildProxiedResponse(response, provider!, modelId!, isStream, estInputTokens);
    }

    // ---- Match by model string ----
    if (parsed.mode === "match") {
      const db = getDb();
      const row = db
        .prepare(`SELECT id, provider, model_id FROM models WHERE id = ? OR model_id = ? LIMIT 1`)
        .get(parsed.modelId, parsed.modelId) as
        | { id: string; provider: string; model_id: string }
        | undefined;

      if (!row) {
        return openAIError(404, { message: `The model '${parsed.modelId}' does not exist`, param: "model" });
      }

      const response = await forwardToProvider(row.provider, row.model_id, body, isStream);
      if (!response.ok && isRetryableStatus(response.status)) {
        const errText = await response.text();
        return openAIError(response.status, { message: errText || `Provider ${row.provider} returned ${response.status}` });
      }
      console.log(`[RES] ${response.status} | ${row.provider}/${row.model_id} | ${Date.now() - _reqTime}ms | match`);
      return buildProxiedResponse(response, row.provider, row.model_id, isStream, estInputTokens);
    }

    // ---- Smart routing: auto / fast / tools / thai ----
    // Map prompt category to benchmark category for scoring
    const benchmarkCategory = caps.hasImages ? "vision" : promptCategory;
    const candidates = selectModelsByMode(parsed.mode, caps, benchmarkCategory);
    // DEBUG: log candidate stats
    const candByProv: Record<string, number> = {};
    candidates.forEach(c => candByProv[c.provider] = (candByProv[c.provider] || 0) + 1);
    console.log(`[DEBUG] mode=${parsed.mode} candidates=${candidates.length} providers=${JSON.stringify(candByProv)}`);

    // Smart routing: boost from real usage stats
    // Skip boost for tools requests — SQL ordering (supports_tools + context_length) is more important
    if (!caps.hasTools) {
      const benchmarkBest = getBestModelsByBenchmarkCategory(benchmarkCategory);
      if (benchmarkBest.length > 0) {
        const bestSet = new Set(benchmarkBest);
        const boosted = candidates.filter(c => bestSet.has(c.id));
        const rest = candidates.filter(c => !bestSet.has(c.id));
        candidates.splice(0, candidates.length, ...boosted, ...rest);
      }
      const learnedBest = getBestModelsForCategory(promptCategory);
      if (learnedBest.length > 0) {
        const bestSet = new Set(learnedBest);
        const boosted = candidates.filter(c => bestSet.has(c.id));
        const rest = candidates.filter(c => !bestSet.has(c.id));
        candidates.splice(0, candidates.length, ...boosted, ...rest);
      }
    }

    console.log(`[DEBUG] after boost: candidates=${candidates.length} top3=[${candidates.slice(0,3).map(c=>c.provider+'/'+c.model_id).join(', ')}]`);
    // ถ้าไม่มี candidate → ลองไม่ filter context → ลองรวม cooldown (สุ่มเลือก ดีกว่า 503)
    let finalCandidates = candidates;
    if (finalCandidates.length === 0) {
      finalCandidates = selectModelsByMode(parsed.mode, caps, benchmarkCategory);
    }
    if (finalCandidates.length === 0) {
      // Last resort: สุ่มจาก ALL models (รวม cooldown) — ดีกว่าไม่ตอบ
      finalCandidates = getAllModelsIncludingCooldown(caps);
    }
    if (finalCandidates.length === 0) {
      return openAIError(503, { message: "No models available. Worker scan has not completed yet." });
    }

    const MAX_RETRIES = 10; // try up to 10 models across different providers
    let lastError = "";
    const startTime = Date.now();
    const userMsg = extractUserMessage(body);
    const triedProviders = new Set<string>();
    const blockedProviders = new Set<string>(); // providers that returned 429 — skip entirely

    // Filter out in-memory provider cooldowns BEFORE retry loop
    const activeCandidates = finalCandidates.filter(c => !isProviderCooledDown(c.provider));
    if (activeCandidates.length > 0) {
      finalCandidates = activeCandidates;
      console.log(`[DEBUG] after provider-cooldown filter: ${finalCandidates.length} candidates`);
    }

    // Weighted Load Balancing
    let spreadCandidates: typeof finalCandidates;

    if (caps.hasTools) {
      // Tools request: ใช้ SQL ordering ตรงๆ (supports_tools + context_length DESC)
      // แค่ดัน ollama ไว้ท้ายสุด
      const nonOllama = finalCandidates.filter(c => c.provider !== "ollama");
      const ollama = finalCandidates.filter(c => c.provider === "ollama");
      spreadCandidates = [...nonOllama, ...ollama];
    } else {
      // Non-tools: round-robin across providers (spread load)
      spreadCandidates = [];
      const byProvider: Record<string, typeof finalCandidates> = {};
      for (const c of finalCandidates) {
        (byProvider[c.provider] ??= []).push(c);
      }
      const providerOrder = Object.entries(byProvider)
        .map(([prov, models]) => {
          const avgLat = models.reduce((s, m) => s + (m.avg_latency ?? 9999999), 0) / models.length;
          const avgScore = models.reduce((s, m) => s + (m.avg_score ?? 0), 0) / models.length;
          const avgRep = models.reduce((s, m) => s + getReputationScore(m.id), 0) / models.length;
          const weight = prov === "ollama" ? -Infinity : avgScore * 1000 * (avgRep / 100) - avgLat;
          return { models, weight };
        })
        .sort((a, b) => b.weight - a.weight);
      let hasMore = true;
      let round = 0;
      const totalExpected = finalCandidates.length;
      while (hasMore && spreadCandidates.length < totalExpected) {
        hasMore = false;
        for (const { models: provModels } of providerOrder) {
          if (round < provModels.length) {
            spreadCandidates.push(provModels[round]);
            hasMore = true;
          }
        }
        round++;
      }
    }

    console.log(`[DEBUG] spread=${spreadCandidates.length} top5=[${spreadCandidates.slice(0,5).map(c=>c.provider+'/'+c.model_id).join(', ')}]`);

    const TOTAL_TIMEOUT_MS = 30_000; // ไม่ retry เกิน 30 วินาทีรวม

    for (let i = 0, tried = 0; i < spreadCandidates.length && tried < MAX_RETRIES; i++) {
      // Total timeout — ถ้าใช้เวลารวมเกิน 30s ให้หยุด retry
      if (Date.now() - startTime > TOTAL_TIMEOUT_MS) {
        console.log(`[TIMEOUT] Total retry time exceeded ${TOTAL_TIMEOUT_MS}ms — stopping`);
        break;
      }
      const candidate = spreadCandidates[i];
      const { provider, model_id: actualModelId, id: dbModelId } = candidate;
      // Skip providers that returned 429 (rate limited) — entire provider is throttled
      if (blockedProviders.has(provider)) continue;
      // Skip providers with in-memory cooldown
      if (isProviderCooledDown(provider)) continue;
      tried++;
      triedProviders.add(provider);

      try {
        const response = await forwardToProvider(provider, actualModelId, body, isStream);

        if (response.ok) {
          const latency = Date.now() - startTime;
          // ช้าเกิน 30s → cooldown 15 นาที แต่ยังส่งผลลัพธ์ให้ user
          const SLOW_THRESHOLD_MS = 30_000;
          const SLOW_COOLDOWN_MINUTES = 15;
          if (latency > SLOW_THRESHOLD_MS && provider !== "ollama") {
            logCooldown(dbModelId, `Slow response: ${(latency / 1000).toFixed(1)}s > ${SLOW_THRESHOLD_MS / 1000}s threshold`, 0, SLOW_COOLDOWN_MINUTES);
            emitEvent("provider_error", `${provider}/${actualModelId} ช้ามาก (${(latency / 1000).toFixed(1)}s)`, `ตอบช้าเกิน ${SLOW_THRESHOLD_MS / 1000}s → cooldown ${SLOW_COOLDOWN_MINUTES} นาที`, provider, actualModelId, "warn");
          } else {
            // Model ทำงานได้เร็วพอ → clear cooldown
            try {
              const db = getDb();
              db.prepare("DELETE FROM health_logs WHERE model_id = ? AND cooldown_until > datetime('now')").run(dbModelId);
            } catch { /* silent */ }
          }
          // Non-stream: validate content quality BEFORE returning
          if (!isStream) {
            try {
              const cloned = response.clone();
              const json = await cloned.json() as { choices?: Array<{ message?: { content?: string; tool_calls?: unknown[] } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
              let content = json.choices?.[0]?.message?.content ?? "";
              const hasToolCalls = Array.isArray(json.choices?.[0]?.message?.tool_calls) && (json.choices[0].message!.tool_calls!.length > 0);

              // Check for bad response (tool_call XML leak, etc.)
              const badReason = isResponseBad(content, caps.hasTools);
              if (badReason && !hasToolCalls) {
                console.log(`[BAD-RESPONSE] ${provider}/${actualModelId} — ${badReason}: "${content.slice(0, 100)}"`);
                logCooldown(dbModelId, badReason, 0, 5); // cooldown 5 min
                recordRoutingResult(dbModelId, provider, promptCategory, false, latency);
                lastError = `${provider}/${actualModelId}: ${badReason}`;
                continue; // retry next model
              }

              // Clean <think> tags
              if (content && THINK_TAG_RE.test(content)) {
                content = cleanResponseContent(content);
                if (json.choices?.[0]?.message) {
                  json.choices[0].message.content = content;
                }
              }

              // Success — log and return
              const usage = json.usage;
              logGateway(modelField, actualModelId, provider, 200, latency,
                usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0,
                null, userMsg, content?.slice(0, 500) ?? null);
              recordRoutingResult(dbModelId, provider, promptCategory, true, latency);

              // Build clean response
              const headers = new Headers();
              headers.set("Content-Type", "application/json");
              headers.set("X-BCProxy-Provider", provider);
              headers.set("X-BCProxy-Model", actualModelId);
              headers.set("Access-Control-Allow-Origin", "*");

              // Normalize content arrays
              if (json.choices) {
                for (const choice of json.choices) {
                  const msg = choice.message;
                  if (msg && Array.isArray(msg.content)) {
                    msg.content = (msg.content as Array<{ type: string; text?: string }>)
                      .filter((p) => p.type === "text")
                      .map((p) => p.text)
                      .join("");
                  }
                }
              }

              trackTokenUsage(provider, actualModelId, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0);
              console.log(`[RES] 200 | ${provider}/${actualModelId} | ${latency}ms | "${_reqMsg}"`);
              return new Response(JSON.stringify(json), { status: 200, headers });
            } catch {
              // JSON parse failed — fall through to normal proxied response
            }
          }

          // Stream or fallback: just proxy through
          const proxied = await buildProxiedResponse(response, provider, actualModelId, isStream, estInputTokens);
          recordRoutingResult(dbModelId, provider, promptCategory, true, latency);
          logGateway(modelField, actualModelId, provider, 200, latency, 0, 0, null, userMsg, "[stream]");
          console.log(`[RES] 200 | ${provider}/${actualModelId} | ${latency}ms | "${_reqMsg}"`);
          return proxied;
        }

        // Non-200: cooldown for cloud providers only (Ollama = local, never cooldown)
        const errText = await response.text().catch(() => "");
        lastError = `${provider}/${actualModelId}: HTTP ${response.status}`;
        recordRoutingResult(dbModelId, provider, promptCategory, false, Date.now() - startTime);
        const st = response.status;
        console.log(`[RETRY] ${tried}/${MAX_RETRIES} | ${provider}/${actualModelId} → HTTP ${st} | ${errText.slice(0, 200)}`);
        if (provider !== "ollama" && (st === 400 || st === 429 || st === 413 || st === 422 || st === 410 || st === 404 || st >= 500 || st === 401 || st === 403)) {
          logCooldown(dbModelId, `HTTP ${st}: ${errText}`, st);
          // Cooldown เฉพาะ model ที่ fail — ไม่ cooldown ทั้ง provider
          // blockedProviders ใช้แค่ภายใน request นี้ สำหรับ 429/401/403
          if (st === 429 || st === 401 || st === 403) {
            blockedProviders.add(provider); // skip provider ใน request นี้เท่านั้น
          }
          if (st === 404) {
            blockedProviders.add(provider);
          }
          if (st === 410) {
            emitEvent("provider_error", `${provider}/${actualModelId} ถูกถอดแล้ว (HTTP 410 Gone)`, errText.slice(0, 200), provider, actualModelId, "error");
          } else if (st >= 500) {
            emitEvent("provider_error", `${provider} ล่ม (HTTP ${st})`, errText.slice(0, 200), provider, actualModelId, "error");
          }
        }
        // Always retry next model regardless
        continue;
      } catch (err) {
        lastError = `${provider}/${actualModelId}: ${String(err)}`;
        logCooldown(dbModelId, lastError);
        recordRoutingResult(dbModelId, provider, promptCategory, false, Date.now() - startTime);
        emitEvent("provider_error", `${provider} เชื่อมต่อไม่ได้`, String(err).slice(0, 200), provider, actualModelId, "warn");
        continue;
      }
    }

    // All retries exhausted
    const latency = Date.now() - startTime;
    logGateway(modelField, null, null, 503, latency, 0, 0, lastError.slice(0, 300), userMsg, null);
    console.log(`[RES] 503 | ${triedProviders.size} providers tried, ${blockedProviders.size} blocked | ${latency}ms | ${lastError.slice(0, 120)}`);
    return openAIError(503, {
      message: `All ${Math.min(MAX_RETRIES, spreadCandidates.length)} models from ${triedProviders.size} providers failed: ${lastError}`,
    });
  } catch (err) {
    console.error("[Gateway] Unexpected error:", err);
    return openAIError(500, { message: String(err) });
  }
}

async function buildProxiedResponse(
  upstream: Response,
  provider: string,
  modelId: string,
  stream: boolean,
  estimatedInputTokens = 0
): Promise<Response> {
  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
  headers.set("X-BCProxy-Provider", provider);
  headers.set("X-BCProxy-Model", modelId);

  // Pass through CORS headers if needed
  headers.set("Access-Control-Allow-Origin", "*");

  if (stream && upstream.body) {
    // Stream SSE — track estimated tokens from content length
    const reader = upstream.body.getReader();
    let totalBytes = 0;
    const passthrough = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          // Estimate output tokens from streamed bytes (~3 chars/token)
          const estOutputTokens = Math.ceil(totalBytes / 3);
          trackTokenUsage(provider, modelId, estimatedInputTokens, estOutputTokens);
          controller.close();
          return;
        }
        totalBytes += value.byteLength;
        controller.enqueue(value);
      },
    });
    return new Response(passthrough, {
      status: upstream.status,
      headers,
    });
  }

  // Non-streaming: read body, fix reasoning→content, track tokens, return
  try {
    const text = await upstream.text();
    const json = JSON.parse(text);

    // Fix: some models (Ollama/gemma4) put answer in reasoning field instead of content
    if (json.choices) {
      for (const choice of json.choices) {
        const msg = choice.message;
        if (msg && (!msg.content || msg.content === "") && msg.reasoning) {
          // Extract actual answer from reasoning (last meaningful line)
          msg.content = msg.reasoning;
        }
      }
    }

    // Fix tool call parameters: some models send numbers as strings
    if (json.choices) {
      for (const choice of json.choices) {
        const toolCalls = choice.message?.tool_calls;
        if (Array.isArray(toolCalls)) {
          for (const tc of toolCalls) {
            if (tc.function?.arguments && typeof tc.function.arguments === "string") {
              try {
                const args = JSON.parse(tc.function.arguments);
                // Auto-fix: convert string numbers to actual numbers
                for (const [key, val] of Object.entries(args)) {
                  if (typeof val === "string" && /^\d+$/.test(val)) {
                    args[key] = Number(val);
                  }
                }
                tc.function.arguments = JSON.stringify(args);
              } catch { /* keep original */ }
            }
          }
        }
      }
    }

    // Normalize content: some providers return array [{type:"text",text:"..."}] instead of string
    if (json.choices) {
      for (const choice of json.choices) {
        const msg = choice.message;
        if (msg && Array.isArray(msg.content)) {
          msg.content = msg.content
            .filter((p: { type: string }) => p.type === "text")
            .map((p: { text: string }) => p.text)
            .join("");
        }
      }
    }

    // Ensure all OpenAI-standard fields exist (id, object, created, system_fingerprint, usage)
    ensureChatCompletionFields(json, provider, modelId);

    // Auto-detect bad responses and file complaint
    const content = json.choices?.[0]?.message?.content ?? "";
    autoDetectComplaint(provider, modelId, content);

    // Track token usage
    const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (usage) {
      trackTokenUsage(provider, modelId, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);
    } else {
      const estOutput = Math.ceil(text.length / 3);
      trackTokenUsage(provider, modelId, estimatedInputTokens, estOutput);
    }

    return new Response(JSON.stringify(json), {
      status: upstream.status,
      headers,
    });
  } catch {
    // Fallback: pass through raw body
    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  }
}

// Handle OPTIONS for CORS preflight
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
