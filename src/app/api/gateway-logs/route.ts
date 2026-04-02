import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDb();
    const logs = db
      .prepare(
        `SELECT id, request_model as requestModel, resolved_model as resolvedModel,
                provider, status, latency_ms as latencyMs,
                input_tokens as inputTokens, output_tokens as outputTokens,
                error, user_message as userMessage, assistant_message as assistantMessage,
                created_at as createdAt
         FROM gateway_logs ORDER BY created_at DESC LIMIT 100`
      )
      .all();

    return NextResponse.json(logs);
  } catch (err) {
    console.error("[gateway-logs] error:", err);
    return NextResponse.json([], { status: 500 });
  }
}
