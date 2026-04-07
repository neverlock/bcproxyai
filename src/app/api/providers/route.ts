import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/schema";
import { PROVIDER_URLS } from "@/lib/providers";

export const dynamic = "force-dynamic";

const ENV_MAP: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  kilo: "KILO_API_KEY",
  google: "GOOGLE_AI_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  sambanova: "SAMBANOVA_API_KEY",
  mistral: "MISTRAL_API_KEY",
  ollama: "OLLAMA_API_KEY",
  github: "GITHUB_MODELS_TOKEN",
  fireworks: "FIREWORKS_API_KEY",
  cohere: "COHERE_API_KEY",
  cloudflare: "CLOUDFLARE_API_TOKEN",
  huggingface: "HF_TOKEN",
};

// Ollama doesn't need a key
const NO_KEY_REQUIRED = new Set(["ollama"]);

export async function GET() {
  try {
    const db = getDb();

    // Count models per provider.
    // A model is considered available if:
    //   1. It has NO health_log entry at all (never checked → assume online), OR
    //   2. Its latest health_log has status='available' AND no active cooldown
    // A model is offline only when it has an active cooldown (cooldown_until > now).
    // Simple: model is available unless it has an active cooldown
    // No health_log = available (default online)
    const rows = db.prepare(`
      SELECT m.provider, COUNT(*) as model_count,
        SUM(CASE WHEN m.id NOT IN (
          SELECT h.model_id FROM health_logs h
          INNER JOIN (SELECT model_id, MAX(id) as max_id FROM health_logs GROUP BY model_id) l
            ON h.model_id = l.model_id AND h.id = l.max_id
          WHERE h.cooldown_until > datetime('now')
        ) THEN 1 ELSE 0 END) as available_count
      FROM models m
      GROUP BY m.provider
    `).all() as { provider: string; model_count: number; available_count: number }[];

    const dbMap = new Map(rows.map(r => [r.provider, r]));

    // Get DB-stored keys
    const dbKeys = new Map<string, string>();
    try {
      const keyRows = db.prepare("SELECT provider, api_key FROM api_keys").all() as { provider: string; api_key: string }[];
      for (const r of keyRows) dbKeys.set(r.provider, r.api_key);
    } catch { /* table may not exist yet */ }

    // Build status for ALL 13 providers
    const ALL_PROVIDERS = Object.keys(PROVIDER_URLS);
    const providers = ALL_PROVIDERS.map(provider => {
      const envVar = ENV_MAP[provider] ?? "";
      const raw = process.env[envVar] ?? "";
      const envKeys = raw.split(",").map(k => k.trim()).filter(Boolean);
      const dbKey = dbKeys.get(provider) ?? "";
      const noKeyRequired = NO_KEY_REQUIRED.has(provider);

      // Has key from either source
      const hasEnvKey = envKeys.length > 0;
      const hasDbKey = dbKey.length > 0;
      const hasKey = noKeyRequired || hasEnvKey || hasDbKey;

      // Check for placeholder keys
      const isPlaceholder = hasEnvKey && !hasDbKey && envKeys.every(k =>
        /^(your_|placeholder|xxx|test|dummy)/i.test(k)
      );

      const dbRow = dbMap.get(provider);
      const modelCount = dbRow?.model_count ?? 0;
      const availableCount = dbRow?.available_count ?? 0;

      let status: "active" | "no_key" | "no_models" | "error";
      if (!hasKey || isPlaceholder) {
        status = "no_key";
      } else if (modelCount === 0) {
        status = "no_models";
      } else if (availableCount > 0) {
        status = "active";
      } else {
        status = "error";
      }

      return {
        provider,
        envVar,
        hasKey: hasKey && !isPlaceholder,
        hasDbKey,
        noKeyRequired,
        modelCount,
        availableCount,
        status,
      };
    });

    return NextResponse.json(providers);
  } catch (err) {
    console.error("[providers] error:", err);
    return NextResponse.json([], { status: 500 });
  }
}
