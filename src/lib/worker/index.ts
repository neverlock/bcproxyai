import { getDb } from "@/lib/db/schema";
import { scanModels } from "./scanner";
import { checkHealth } from "./health";
import { runBenchmarks } from "./benchmark";

export { scanModels } from "./scanner";
export { checkHealth } from "./health";
export { runBenchmarks } from "./benchmark";

export interface WorkerStatus {
  status: "idle" | "running" | "error";
  lastRun: string | null;
  nextRun: string | null;
  stats: {
    scan?: { found: number; new: number };
    health?: { checked: number; available: number; cooldown: number };
    benchmark?: { tested: number; questions: number };
  };
}

let workerTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

function getState(key: string): string | null {
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM worker_state WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function setState(key: string, value: string) {
  try {
    const db = getDb();
    db.prepare(
      "INSERT OR REPLACE INTO worker_state (key, value) VALUES (?, ?)"
    ).run(key, value);
  } catch {
    // silent
  }
}

function logWorker(step: string, message: string, level = "info") {
  try {
    const db = getDb();
    db.prepare(
      "INSERT INTO worker_logs (step, message, level) VALUES (?, ?, ?)"
    ).run(step, message, level);
  } catch {
    // silent
  }
}

function cleanOldLogs(): void {
  try {
    const db = getDb();
    const workerResult = db
      .prepare("DELETE FROM worker_logs WHERE created_at < datetime('now', '-30 days')")
      .run();
    const healthResult = db
      .prepare("DELETE FROM health_logs WHERE checked_at < datetime('now', '-30 days')")
      .run();
    const gatewayResult = db
      .prepare("DELETE FROM gateway_logs WHERE created_at < datetime('now', '-30 days')")
      .run();
    logWorker(
      "cleanup",
      `🧹 ลบ log เก่า: worker ${workerResult.changes}, health ${healthResult.changes}, gateway ${gatewayResult.changes} แถว`
    );
  } catch (err) {
    logWorker("cleanup", `Log cleanup failed: ${err}`, "error");
  }
}

export async function runWorkerCycle(): Promise<void> {
  if (isRunning) {
    logWorker("worker", "Cycle skipped — already running", "warn");
    return;
  }

  isRunning = true;
  setState("status", "running");
  setState("last_run", new Date().toISOString());

  const next = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  setState("next_run", next);

  logWorker("worker", "Worker cycle started");

  // Clean old logs before scanning
  cleanOldLogs();

  let scanResult = { found: 0, new: 0 };
  let healthResult = { checked: 0, available: 0, cooldown: 0 };
  let benchmarkResult = { tested: 0, questions: 0 };

  try {
    // Step 1: Scan
    logWorker("worker", "Step 1: Scanning models");
    scanResult = await scanModels();
  } catch (err) {
    logWorker("worker", `Step 1 (scan) failed: ${err}`, "error");
  }

  try {
    // Step 2: Health check
    logWorker("worker", "Step 2: Health check");
    healthResult = await checkHealth();
  } catch (err) {
    logWorker("worker", `Step 2 (health) failed: ${err}`, "error");
  }

  try {
    // Step 3: Benchmark
    logWorker("worker", "Step 3: Benchmark");
    benchmarkResult = await runBenchmarks();
  } catch (err) {
    logWorker("worker", `Step 3 (benchmark) failed: ${err}`, "error");
  }

  setState("status", "idle");
  setState(
    "last_stats",
    JSON.stringify({ scan: scanResult, health: healthResult, benchmark: benchmarkResult })
  );

  logWorker(
    "worker",
    `Cycle complete — scan:${scanResult.found}/${scanResult.new} health:${healthResult.available}/${healthResult.checked} benchmark:${benchmarkResult.tested}/${benchmarkResult.questions}`
  );

  isRunning = false;
}

export function startWorker(): void {
  if (workerTimer) return; // already started

  logWorker("worker", "Worker starting — running immediately then every 1h");

  // Run once immediately (async, don't block)
  runWorkerCycle().catch((err) => {
    logWorker("worker", `Initial cycle error: ${err}`, "error");
    isRunning = false;
    setState("status", "error");
  });

  // Then every 1 hour
  workerTimer = setInterval(() => {
    runWorkerCycle().catch((err) => {
      logWorker("worker", `Scheduled cycle error: ${err}`, "error");
      isRunning = false;
      setState("status", "error");
    });
  }, 60 * 60 * 1000);
}

export function getWorkerStatus(): WorkerStatus {
  const status = (getState("status") ?? "idle") as WorkerStatus["status"];
  const lastRun = getState("last_run");
  const nextRun = getState("next_run");
  const statsRaw = getState("last_stats");

  let stats: WorkerStatus["stats"] = {};
  if (statsRaw) {
    try {
      stats = JSON.parse(statsRaw);
    } catch {
      // ignore
    }
  }

  return { status, lastRun, nextRun, stats };
}
