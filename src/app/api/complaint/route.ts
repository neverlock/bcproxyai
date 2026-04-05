import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/schema";
import { processComplaint } from "@/lib/worker/complaint";

export const dynamic = "force-dynamic";

// 7 complaint categories
const VALID_CATEGORIES = [
  "wrong_answer",    // ตอบผิด
  "gibberish",       // พูดไม่รู้เรื่อง
  "wrong_language",  // ตอบผิดภาษา
  "refused",         // ปฏิเสธตอบ
  "hallucination",   // แต่งเรื่อง
  "too_short",       // ตอบสั้นเกินไป
  "irrelevant",      // ตอบไม่ตรงคำถาม
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  wrong_answer: "ตอบผิด",
  gibberish: "พูดไม่รู้เรื่อง",
  wrong_language: "ตอบผิดภาษา",
  refused: "ปฏิเสธตอบ",
  hallucination: "แต่งเรื่อง",
  too_short: "ตอบสั้นเกินไป",
  irrelevant: "ตอบไม่ตรงคำถาม",
};

// POST /api/complaint — file a complaint
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { model_id, category, reason, user_message, assistant_message } = body;

    // Validate
    if (!model_id || typeof model_id !== "string") {
      return NextResponse.json(
        { error: "model_id is required" },
        { status: 400 }
      );
    }
    if (!category || !VALID_CATEGORIES.includes(category)) {
      return NextResponse.json(
        { error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` },
        { status: 400 }
      );
    }

    const db = getDb();

    // Find model
    const model = db.prepare(
      "SELECT id, provider, model_id, nickname FROM models WHERE id = ? OR model_id = ? OR (provider || '/' || model_id) = ?"
    ).get(model_id, model_id, model_id) as { id: string; provider: string; model_id: string; nickname: string | null } | undefined;

    if (!model) {
      return NextResponse.json(
        { error: `Model not found: ${model_id}` },
        { status: 404 }
      );
    }

    // Check daily complaint limit (max 10 per model per day)
    const today = new Date().toISOString().slice(0, 10);
    const dailyCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM complaints WHERE model_id = ? AND created_at >= ?"
    ).get(model.id, `${today}T00:00:00`) as { cnt: number };

    if (dailyCount.cnt >= 10) {
      // Auto-blacklist: 10+ complaints in a day = 24hr cooldown
      const cooldownUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      db.prepare(
        "INSERT INTO health_logs (model_id, status, error, cooldown_until, checked_at) VALUES (?, 'blacklisted', ?, ?, datetime('now'))"
      ).run(model.id, `Blacklisted: ${dailyCount.cnt + 1} complaints today`, cooldownUntil);

      return NextResponse.json({
        message: `Model ${model.model_id} blacklisted for 24hr (${dailyCount.cnt + 1} complaints today)`,
        blacklisted: true,
      });
    }

    // Insert complaint
    const result = db.prepare(
      "INSERT INTO complaints (model_id, category, reason, user_message, assistant_message, source) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      model.id,
      category,
      reason?.slice(0, 500) ?? null,
      user_message?.slice(0, 500) ?? null,
      assistant_message?.slice(0, 500) ?? null,
      body.source ?? "api"
    );

    const complaintId = result.lastInsertRowid;

    // Cooldown 30 min immediately
    const cooldownUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO health_logs (model_id, status, error, cooldown_until, checked_at) VALUES (?, 'complained', ?, ?, datetime('now'))"
    ).run(model.id, `Complaint #${complaintId}: ${CATEGORY_LABELS[category]}`, cooldownUntil);

    // Process complaint exam in background (non-blocking)
    processComplaint(Number(complaintId), model.id, model.provider, model.model_id, category, user_message).catch(() => {});

    return NextResponse.json({
      id: complaintId,
      model_id: model.model_id,
      provider: model.provider,
      nickname: model.nickname,
      category,
      category_label: CATEGORY_LABELS[category],
      cooldown_until: cooldownUntil,
      message: `Complaint filed. ${model.model_id} cooldown 30 min, re-exam scheduled.`,
      daily_complaints: dailyCount.cnt + 1,
    });
  } catch (err) {
    console.error("[Complaint] Error:", err);
    return NextResponse.json(
      { error: String(err) },
      { status: 500 }
    );
  }
}

// GET /api/complaint — list complaints
export async function GET(req: NextRequest) {
  try {
    const db = getDb();
    const url = new URL(req.url);
    const modelId = url.searchParams.get("model_id");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

    let whereClause = "";
    const params: unknown[] = [];

    if (modelId) {
      whereClause = "WHERE c.model_id = ? OR m.model_id = ?";
      params.push(modelId, modelId);
    }

    const complaints = db.prepare(`
      SELECT
        c.id,
        c.model_id as db_model_id,
        m.model_id,
        m.provider,
        m.nickname,
        c.category,
        c.reason,
        c.user_message,
        c.assistant_message,
        c.source,
        c.status,
        c.created_at,
        ce.score as exam_score,
        ce.passed as exam_passed,
        ce.question as exam_question,
        ce.answer as exam_answer,
        ce.reasoning as exam_reasoning
      FROM complaints c
      JOIN models m ON c.model_id = m.id
      LEFT JOIN complaint_exams ce ON ce.complaint_id = c.id
      ${whereClause}
      ORDER BY c.created_at DESC
      LIMIT ?
    `).all(...params, limit) as Record<string, unknown>[];

    // Stats
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'exam_passed' THEN 1 ELSE 0 END) as passed,
        SUM(CASE WHEN status = 'exam_failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'blacklisted' THEN 1 ELSE 0 END) as blacklisted
      FROM complaints
    `).get() as Record<string, number>;

    // Top complained models
    const topComplained = db.prepare(`
      SELECT m.model_id, m.provider, m.nickname, COUNT(*) as complaint_count
      FROM complaints c
      JOIN models m ON c.model_id = m.id
      GROUP BY c.model_id
      ORDER BY complaint_count DESC
      LIMIT 10
    `).all() as Record<string, unknown>[];

    return NextResponse.json({
      complaints,
      stats,
      top_complained: topComplained,
      categories: CATEGORY_LABELS,
    });
  } catch (err) {
    console.error("[Complaint] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
