import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(Number(searchParams.get("limit")) || 100, 500);
    const offset = Number(searchParams.get("offset")) || 0;

    const db = getDb();

    const countRow = db
      .prepare("SELECT COUNT(*) as total FROM gateway_logs")
      .get() as { total: number };

    const logs = db
      .prepare(
        `SELECT id, request_model as requestModel, resolved_model as resolvedModel,
                provider, status, latency_ms as latencyMs,
                input_tokens as inputTokens, output_tokens as outputTokens,
                error, user_message as userMessage, assistant_message as assistantMessage,
                created_at as createdAt
         FROM gateway_logs ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(limit, offset);

    return NextResponse.json({ logs, total: countRow.total, limit, offset });
  } catch (err) {
    console.error("[gateway-logs] error:", err);
    return NextResponse.json({ logs: [], total: 0, limit: 100, offset: 0 }, { status: 500 });
  }
}
