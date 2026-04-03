import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/schema";
import { getCached, setCache } from "@/lib/cache";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const cached = getCached<unknown[]>("api:leaderboard");
    if (cached) return NextResponse.json(cached);

    const db = getDb();

    const rows = db
      .prepare(`
        SELECT
          m.name,
          m.provider,
          m.model_id as modelId,
          m.tier,
          AVG(b.score) as avgScore,
          SUM(b.score) as totalScore,
          SUM(b.max_score) as maxScore,
          COUNT(b.id) as questionsAnswered,
          AVG(b.latency_ms) as avgLatencyMs
        FROM benchmark_results b
        INNER JOIN models m ON b.model_id = m.id
        GROUP BY b.model_id
        HAVING questionsAnswered >= 1
        ORDER BY avgScore DESC, totalScore DESC
      `)
      .all() as Array<{
      name: string;
      provider: string;
      modelId: string;
      tier: string;
      avgScore: number;
      totalScore: number;
      maxScore: number;
      questionsAnswered: number;
      avgLatencyMs: number;
    }>;

    const result = rows.map((r, i) => ({
      rank: i + 1,
      name: r.name,
      provider: r.provider,
      modelId: r.modelId,
      avgScore: Math.round(r.avgScore * 100) / 100,
      totalScore: Math.round(r.totalScore * 100) / 100,
      maxScore: r.maxScore,
      percentage:
        r.maxScore > 0 ? Math.round((r.totalScore / r.maxScore) * 100) : 0,
      questionsAnswered: r.questionsAnswered,
      avgLatencyMs: Math.round(r.avgLatencyMs),
      tier: r.tier,
    }));

    setCache("api:leaderboard", result, 5000); // cache 5 seconds
    return NextResponse.json(result);
  } catch (err) {
    console.error("[leaderboard] error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
