import { getDb } from "@/lib/db/schema";
import { processComplaint } from "@/lib/worker/complaint";

/**
 * Auto-detect bad responses and file complaints automatically
 * Called from gateway after every non-streaming response
 * Non-blocking: runs complaint processing in background
 */
export function autoDetectComplaint(
  provider: string,
  modelId: string,
  content: string
): void {
  // Skip Ollama (local, user controls quality)
  if (provider === "ollama") return;

  const trimmed = (content ?? "").trim();
  let category: string | null = null;

  // Empty response
  if (!trimmed) {
    category = "refused";
  }
  // Too short (< 5 chars for a response)
  else if (trimmed.length < 5) {
    category = "too_short";
  }
  // Gibberish: mostly non-printable or replacement characters
  else if (hasGarbageChars(trimmed)) {
    category = "gibberish";
  }

  if (!category) return;

  // Find model in DB and file complaint
  try {
    const db = getDb();
    const model = db.prepare(
      "SELECT id FROM models WHERE provider = ? AND model_id = ? LIMIT 1"
    ).get(provider, modelId) as { id: string } | undefined;

    if (!model) return;

    // Rate limit: max 1 auto-complaint per model per 30 min
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const recent = db.prepare(
      "SELECT id FROM complaints WHERE model_id = ? AND source = 'auto' AND created_at >= ? LIMIT 1"
    ).get(model.id, thirtyMinAgo);

    if (recent) return; // Already complained recently

    // File complaint
    const result = db.prepare(
      "INSERT INTO complaints (model_id, category, reason, source) VALUES (?, ?, ?, 'auto')"
    ).run(model.id, category, `Auto-detected: ${category} (content length: ${trimmed.length})`);

    const complaintId = Number(result.lastInsertRowid);

    // Cooldown 30 min
    const cooldownUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO health_logs (model_id, status, error, cooldown_until, checked_at) VALUES (?, 'complained', ?, ?, datetime('now'))"
    ).run(model.id, `Auto-complaint: ${category}`, cooldownUntil);

    // Process re-exam in background
    processComplaint(complaintId, model.id, provider, modelId, category).catch(() => {});

    console.log(`[Auto-Complaint] ${provider}/${modelId}: ${category}`);
  } catch {
    // Non-critical
  }
}

/**
 * Check if text contains mostly garbage/non-printable characters
 */
function hasGarbageChars(text: string): boolean {
  let garbage = 0;
  for (let i = 0; i < Math.min(text.length, 100); i++) {
    const code = text.charCodeAt(i);
    if (code === 0xFFFD || (code < 32 && code !== 10 && code !== 13 && code !== 9)) {
      garbage++;
    }
  }
  return garbage > text.length * 0.3; // >30% garbage
}
