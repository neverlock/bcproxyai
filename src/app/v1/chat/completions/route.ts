import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Provider base URLs
const PROVIDER_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  kilo: "https://api.kilo.ai/api/gateway/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
};

// Provider API keys from env
function getApiKey(provider: string): string {
  switch (provider) {
    case "openrouter":
      return process.env.OPENROUTER_API_KEY || "";
    case "kilo":
      return process.env.KILO_API_KEY || "";
    case "groq":
      return process.env.GROQ_API_KEY || "";
    default:
      return "";
  }
}

interface ModelRow {
  id: string;
  provider: string;
  model_id: string;
  supports_tools: number;
  supports_vision: number;
  tier: string;
  avg_score: number | null;
  avg_latency: number | null;
  health_status: string | null;
  cooldown_until: string | null;
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

function getAvailableModels(caps: RequestCapabilities): ModelRow[] {
  const db = getDb();
  const now = new Date().toISOString();

  const filters: string[] = [
    "(h.status IS NULL OR h.status = 'available' OR h.status = 'error')",
    "(h.cooldown_until IS NULL OR h.cooldown_until < ?)",
  ];
  if (caps.hasTools) filters.push("m.supports_tools = 1");
  if (caps.hasImages) filters.push("m.supports_vision = 1");

  const whereClause = filters.join(" AND ");
  // For json_schema: prefer large tier but don't exclude others
  const orderClause = caps.needsJsonSchema
    ? "CASE WHEN m.tier = 'large' THEN 0 ELSE 1 END ASC, avg_score DESC, avg_latency ASC"
    : "avg_score DESC, avg_latency ASC";

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
        COALESCE(b.avg_score, 0) as avg_score,
        COALESCE(b.avg_latency, 9999999) as avg_latency,
        h.status as health_status,
        h.cooldown_until
      FROM models m
      LEFT JOIN (
        SELECT model_id, AVG(score) as avg_score, AVG(latency_ms) as avg_latency
        FROM benchmark_results
        GROUP BY model_id
      ) b ON m.id = b.model_id
      LEFT JOIN (
        SELECT hl.model_id, hl.status, hl.cooldown_until
        FROM health_logs hl
        INNER JOIN (
          SELECT model_id, MAX(checked_at) as max_checked
          FROM health_logs
          GROUP BY model_id
        ) latest ON hl.model_id = latest.model_id AND hl.checked_at = latest.max_checked
      ) h ON m.id = h.model_id
      WHERE ${whereClause}
      ORDER BY ${orderClause}
    `
    )
    .all(now) as ModelRow[];

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
  return JSON.stringify(last.content).slice(0, 500);
}

function logCooldown(modelId: string, errorMsg: string) {
  try {
    const db = getDb();
    const cooldownUntil = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO health_logs (model_id, status, error, cooldown_until, checked_at)
       VALUES (?, 'rate_limited', ?, ?, datetime('now'))`
    ).run(modelId, errorMsg, cooldownUntil);
  } catch {
    // non-critical
  }
}

function parseModelField(model: string): {
  mode: "auto" | "fast" | "tools" | "thai" | "direct" | "match";
  provider?: string;
  modelId?: string;
} {
  if (!model || model === "auto" || model === "bcproxy/auto") {
    return { mode: "auto" };
  }
  if (model === "bcproxy/fast") return { mode: "fast" };
  if (model === "bcproxy/tools") return { mode: "tools" };
  if (model === "bcproxy/thai") return { mode: "thai" };

  // openrouter/xxx, kilo/xxx, groq/xxx
  const providerMatch = model.match(/^(openrouter|kilo|groq)\/(.+)$/);
  if (providerMatch) {
    return { mode: "direct", provider: providerMatch[1], modelId: providerMatch[2] };
  }

  return { mode: "match", modelId: model };
}

function selectModelsByMode(
  mode: string,
  caps: RequestCapabilities
): ModelRow[] {
  const db = getDb();
  const now = new Date().toISOString();

  if (mode === "fast") {
    // fastest = lowest latency, still apply capability filters
    const filters: string[] = [
      "(h.status IS NULL OR h.status = 'available' OR h.status = 'error')",
      "(h.cooldown_until IS NULL OR h.cooldown_until < ?)",
    ];
    if (caps.hasTools) filters.push("m.supports_tools = 1");
    if (caps.hasImages) filters.push("m.supports_vision = 1");
    const whereClause = filters.join(" AND ");

    const rows = db
      .prepare(
        `
        SELECT
          m.id, m.provider, m.model_id, m.supports_tools, m.supports_vision, m.tier,
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
    // Force tools filter regardless of request body
    return getAvailableModels({ ...caps, hasTools: true });
  }

  // auto / thai → detect from request automatically
  return getAvailableModels(caps);
}

async function forwardToProvider(
  provider: string,
  actualModelId: string,
  body: Record<string, unknown>,
  stream: boolean
): Promise<Response> {
  const url = PROVIDER_URLS[provider];
  if (!url) throw new Error(`Unknown provider: ${provider}`);

  const apiKey = getApiKey(provider);
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

  const requestBody = { ...body, model: actualModelId };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });

  return response;
}

function isRetryableStatus(status: number): boolean {
  return status === 413 || status === 429 || status >= 500;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const modelField = (body.model as string) || "auto";
    const isStream = body.stream === true;
    const caps = detectRequestCapabilities(body);

    const parsed = parseModelField(modelField);

    // ---- Direct provider routing (openrouter/xxx, kilo/xxx, groq/xxx) ----
    if (parsed.mode === "direct") {
      const { provider, modelId } = parsed;
      const response = await forwardToProvider(provider!, modelId!, body, isStream);

      if (!response.ok && isRetryableStatus(response.status)) {
        const errText = await response.text();
        return NextResponse.json(
          { error: { message: errText, type: "provider_error", code: response.status } },
          { status: response.status }
        );
      }

      return buildProxiedResponse(response, provider!, modelId!, isStream);
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
        return NextResponse.json(
          {
            error: {
              message: `Model not found: ${parsed.modelId}`,
              type: "invalid_request_error",
              code: 404,
            },
          },
          { status: 404 }
        );
      }

      const response = await forwardToProvider(row.provider, row.model_id, body, isStream);
      if (!response.ok && isRetryableStatus(response.status)) {
        const errText = await response.text();
        return NextResponse.json(
          { error: { message: errText, type: "provider_error", code: response.status } },
          { status: response.status }
        );
      }
      return buildProxiedResponse(response, row.provider, row.model_id, isStream);
    }

    // ---- Smart routing: auto / fast / tools / thai ----
    const candidates = selectModelsByMode(parsed.mode, caps);

    if (candidates.length === 0) {
      return NextResponse.json(
        {
          error: {
            message: "No models available",
            type: "server_error",
            code: 503,
          },
        },
        { status: 503 }
      );
    }

    const MAX_RETRIES = 3;
    let lastError = "";
    const startTime = Date.now();
    const userMsg = extractUserMessage(body);

    for (let i = 0; i < Math.min(MAX_RETRIES, candidates.length); i++) {
      const candidate = candidates[i];
      const { provider, model_id: actualModelId, id: dbModelId } = candidate;

      try {
        const response = await forwardToProvider(provider, actualModelId, body, isStream);

        if (response.ok) {
          const latency = Date.now() - startTime;
          // Log success (tokens extracted from non-stream response later, use 0 for stream)
          logGateway(modelField, actualModelId, provider, 200, latency, 0, 0, null, userMsg, null);
          return buildProxiedResponse(response, provider, actualModelId, isStream);
        }

        // Retryable error
        if (isRetryableStatus(response.status)) {
          const errText = await response.text();
          lastError = `${provider}/${actualModelId}: HTTP ${response.status} ${errText}`;

          // Log cooldown for rate limit or request too large
          if (response.status === 429 || response.status === 413) {
            logCooldown(dbModelId, `HTTP ${response.status}: ${errText}`);
          }
          continue;
        }

        // Non-retryable error (4xx except 429/413)
        const errBody = await response.text();
        const latency = Date.now() - startTime;
        logGateway(modelField, actualModelId, provider, response.status, latency, 0, 0, errBody.slice(0, 300), userMsg, null);
        return NextResponse.json(
          { error: { message: errBody, type: "provider_error", code: response.status } },
          { status: response.status }
        );
      } catch (err) {
        lastError = `${provider}/${actualModelId}: ${String(err)}`;
        logCooldown(dbModelId, lastError);
        continue;
      }
    }

    // All retries exhausted
    const latency = Date.now() - startTime;
    logGateway(modelField, null, null, 503, latency, 0, 0, lastError.slice(0, 300), userMsg, null);
    return NextResponse.json(
      {
        error: {
          message: `All models unavailable. Last error: ${lastError}`,
          type: "server_error",
          code: 503,
        },
      },
      { status: 503 }
    );
  } catch (err) {
    console.error("[Gateway] Unexpected error:", err);
    return NextResponse.json(
      {
        error: {
          message: String(err),
          type: "server_error",
          code: 500,
        },
      },
      { status: 500 }
    );
  }
}

function buildProxiedResponse(
  upstream: Response,
  provider: string,
  modelId: string,
  stream: boolean
): Response {
  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
  headers.set("X-BCProxy-Provider", provider);
  headers.set("X-BCProxy-Model", modelId);

  // Pass through CORS headers if needed
  headers.set("Access-Control-Allow-Origin", "*");

  if (stream && upstream.body) {
    // Stream SSE chunks directly
    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  }

  // Non-streaming: pass through body
  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
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
