import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/schema";
import { getCached, setCache } from "@/lib/cache";

export const dynamic = "force-dynamic";

interface HealthResult {
  status: "healthy" | "degraded" | "down";
  checks: {
    database: { ok: boolean; latencyMs: number };
    providers: {
      total: number;
      available: number;
      cooldown: number;
      percentAvailable: number;
    };
    worker: {
      status: string;
      lastRun: string | null;
      minutesSinceLastRun: number;
    };
    gateway: {
      recentSuccessRate: number;
      avgLatencyMs: number;
    };
  };
  alerts: string[];
}

export async function GET() {
  try {
    const cached = getCached<HealthResult>("api:health");
    if (cached) return NextResponse.json(cached);

    const alerts: string[] = [];

    // --- Database check ---
    let dbOk = false;
    let dbLatencyMs = 0;
    let db: ReturnType<typeof getDb>;
    try {
      const dbStart = Date.now();
      db = getDb();
      db.prepare("SELECT 1").get();
      dbLatencyMs = Date.now() - dbStart;
      dbOk = true;
      if (dbLatencyMs > 100) {
        alerts.push(`Database latency สูง (${dbLatencyMs}ms > 100ms)`);
      }
    } catch {
      alerts.push("Database ไม่สามารถเชื่อมต่อได้");
      const result: HealthResult = {
        status: "down",
        checks: {
          database: { ok: false, latencyMs: 0 },
          providers: { total: 0, available: 0, cooldown: 0, percentAvailable: 0 },
          worker: { status: "unknown", lastRun: null, minutesSinceLastRun: -1 },
          gateway: { recentSuccessRate: 0, avgLatencyMs: 0 },
        },
        alerts,
      };
      return NextResponse.json(result, { status: 503 });
    }

    // --- Provider availability ---
    const totalRow = db.prepare("SELECT COUNT(*) as count FROM models").get() as { count: number };
    const total = totalRow.count;

    const availableRow = db.prepare(`
      SELECT COUNT(DISTINCT m.id) as count
      FROM models m
      LEFT JOIN (
        SELECT hl.model_id, hl.status, hl.cooldown_until
        FROM health_logs hl
        INNER JOIN (
          SELECT model_id, MAX(checked_at) as max_checked
          FROM health_logs GROUP BY model_id
        ) latest ON hl.model_id = latest.model_id AND hl.checked_at = latest.max_checked
      ) h ON m.id = h.model_id
      WHERE (h.status IS NULL OR h.status = 'available' OR h.status = 'error')
        AND (h.cooldown_until IS NULL OR h.cooldown_until <= datetime('now'))
    `).get() as { count: number };
    const available = availableRow.count;

    const cooldownRow = db.prepare(`
      SELECT COUNT(DISTINCT h.model_id) as count
      FROM health_logs h
      INNER JOIN (
        SELECT model_id, MAX(checked_at) as max_checked
        FROM health_logs GROUP BY model_id
      ) latest ON h.model_id = latest.model_id AND h.checked_at = latest.max_checked
      WHERE h.cooldown_until > datetime('now')
    `).get() as { count: number };
    const cooldown = cooldownRow.count;

    const percentAvailable = total > 0 ? Math.round((available / total) * 100) : 0;

    if (percentAvailable === 0 && total > 0) {
      alerts.push("ทุกโมเดลติด cooldown — อาจถูก rate limit ทั้งหมด");
    }

    // --- Worker status ---
    const statusRow = db.prepare("SELECT value FROM worker_state WHERE key = 'status'").get() as { value: string } | undefined;
    const lastRunRow = db.prepare("SELECT value FROM worker_state WHERE key = 'last_run'").get() as { value: string } | undefined;

    const workerStatus = statusRow?.value ?? "unknown";
    const lastRun = lastRunRow?.value ?? null;

    let minutesSinceLastRun = -1;
    if (lastRun) {
      const lastRunDate = new Date(lastRun);
      minutesSinceLastRun = Math.round((Date.now() - lastRunDate.getTime()) / 60000);
      const hoursSince = minutesSinceLastRun / 60;
      if (hoursSince >= 2) {
        alerts.push(`Worker ไม่ทำงานมา ${Math.round(hoursSince * 10) / 10} ชม.`);
      }
    } else {
      alerts.push("Worker ยังไม่เคยทำงาน");
    }

    // --- Gateway success rate (last 100 requests) ---
    const gatewayRows = db.prepare(`
      SELECT status FROM gateway_logs ORDER BY created_at DESC LIMIT 100
    `).all() as Array<{ status: number }>;

    let recentSuccessRate = 100;
    let avgLatencyMs = 0;
    if (gatewayRows.length > 0) {
      const successCount = gatewayRows.filter(r => r.status >= 200 && r.status < 300).length;
      recentSuccessRate = Math.round((successCount / gatewayRows.length) * 100);

      const latencyRow = db.prepare(`
        SELECT AVG(latency_ms) as avg FROM (
          SELECT latency_ms FROM gateway_logs ORDER BY created_at DESC LIMIT 100
        )
      `).get() as { avg: number | null };
      avgLatencyMs = Math.round(latencyRow.avg ?? 0);
    }

    if (recentSuccessRate < 50) {
      alerts.push(`Success rate ต่ำกว่า 50% (${recentSuccessRate}%)`);
    }

    // --- Determine overall status ---
    let status: "healthy" | "degraded" | "down" = "healthy";

    if (percentAvailable === 0 || !dbOk) {
      status = "down";
    } else if (
      percentAvailable <= 20 ||
      minutesSinceLastRun >= 120 ||
      recentSuccessRate <= 50 ||
      dbLatencyMs > 100
    ) {
      status = "degraded";
    }

    const result: HealthResult = {
      status,
      checks: {
        database: { ok: dbOk, latencyMs: dbLatencyMs },
        providers: { total, available, cooldown, percentAvailable },
        worker: { status: workerStatus, lastRun, minutesSinceLastRun },
        gateway: { recentSuccessRate, avgLatencyMs },
      },
      alerts,
    };

    setCache("api:health", result, 5000); // cache 5 seconds
    return NextResponse.json(result);
  } catch (err) {
    console.error("[health] error:", err);
    return NextResponse.json(
      {
        status: "down",
        checks: {
          database: { ok: false, latencyMs: 0 },
          providers: { total: 0, available: 0, cooldown: 0, percentAvailable: 0 },
          worker: { status: "unknown", lastRun: null, minutesSinceLastRun: -1 },
          gateway: { recentSuccessRate: 0, avgLatencyMs: 0 },
        },
        alerts: [`Internal error: ${String(err)}`],
      },
      { status: 500 }
    );
  }
}
