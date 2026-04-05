import { getDb } from "@/lib/db/schema";
import { askModel, judgeAnswer } from "./benchmark";
import { generateNickname } from "./scanner";

// Complaint category to exam question mapping
const CATEGORY_EXAM_QUESTIONS: Record<string, string[]> = {
  wrong_answer: [
    "ประเทศไทยมีกี่จังหวัด?",
    "น้ำแข็งแห้งทำมาจากอะไร?",
    "ดวงอาทิตย์ขึ้นทางทิศไหน?",
  ],
  gibberish: [
    "อธิบายว่าฝนตกเกิดจากอะไร ใน 2-3 ประโยค",
    "เล่าเรื่องย่อนิทานเรื่องกระต่ายกับเต่า",
  ],
  wrong_language: [
    "ตอบเป็นภาษาไทยเท่านั้น: ประเทศไทยอยู่ทวีปอะไร?",
    "ตอบเป็นภาษาไทย: อาหารไทยที่ชาวต่างชาตินิยมคืออะไร?",
  ],
  refused: [
    "แนะนำหนังสือน่าอ่าน 3 เล่ม",
    "เล่าเรื่องตลกสั้นๆ ให้ฟังหน่อย",
  ],
  hallucination: [
    "1+1 เท่ากับเท่าไหร่?",
    "ประเทศญี่ปุ่นอยู่ทวีปอะไร?",
    "น้ำเดือดที่อุณหภูมิกี่องศาเซลเซียส?",
  ],
  too_short: [
    "อธิบายความแตกต่างระหว่างแมวกับสุนัข อย่างน้อย 3 ข้อ",
    "แนะนำสถานที่ท่องเที่ยวในกรุงเทพ 5 แห่ง พร้อมเหตุผล",
  ],
  irrelevant: [
    "กรุณาตอบคำถามนี้ตรงๆ: เมืองหลวงของไทยคืออะไร?",
    "ตอบให้ตรงประเด็น: 2+2 เท่ากับเท่าไหร่?",
  ],
};

// Score threshold: below this = failed re-exam
const PASS_THRESHOLD = 5;

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

/**
 * Process a complaint: re-exam the model with targeted questions
 * Called async from the complaint API (non-blocking)
 */
export async function processComplaint(
  complaintId: number,
  dbModelId: string,
  provider: string,
  modelId: string,
  category: string,
  originalQuestion?: string
): Promise<void> {
  const db = getDb();

  logWorker("complaint", `Processing complaint #${complaintId} for ${provider}/${modelId} [${category}]`);

  // Pick a question matching the complaint category
  const questions = CATEGORY_EXAM_QUESTIONS[category] ?? CATEGORY_EXAM_QUESTIONS.wrong_answer;
  const question = originalQuestion
    ? originalQuestion  // Re-test with the actual question that was complained about
    : questions[Math.floor(Math.random() * questions.length)];

  // Ask the model
  const { answer, latency, error } = await askModel(provider, modelId, question);

  if (error) {
    logWorker("complaint", `Re-exam failed for ${modelId}: ${error}`, "warn");

    // Insert failed exam
    db.prepare(`
      INSERT INTO complaint_exams (complaint_id, model_id, question, answer, score, passed, reasoning, latency_ms)
      VALUES (?, ?, ?, ?, 0, 0, ?, ?)
    `).run(complaintId, dbModelId, question, "", `Re-exam error: ${error}`, latency);

    db.prepare("UPDATE complaints SET status = 'exam_failed' WHERE id = ?").run(complaintId);

    // Extend cooldown to 2 hours (failed to even respond)
    const cooldownUntil = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO health_logs (model_id, status, error, cooldown_until, checked_at) VALUES (?, 'complained', ?, ?, datetime('now'))"
    ).run(dbModelId, `Re-exam failed: ${error}`, cooldownUntil);

    // Update benchmark score (penalty)
    db.prepare(`
      INSERT INTO benchmark_results (model_id, question, answer, score, max_score, reasoning, latency_ms)
      VALUES (?, ?, ?, 0, 10, ?, ?)
    `).run(dbModelId, `[complaint] ${question}`, "", `Complaint re-exam: failed to respond`, latency);

    return;
  }

  // Judge the answer
  const { score, reasoning } = await judgeAnswer(question, answer);
  const passed = score >= PASS_THRESHOLD;

  logWorker(
    "complaint",
    `Re-exam result: ${modelId} scored ${score}/10 on "${question.slice(0, 30)}..." — ${passed ? "PASSED" : "FAILED"}`,
    passed ? "success" : "warn"
  );

  // Save exam result
  db.prepare(`
    INSERT INTO complaint_exams (complaint_id, model_id, question, answer, score, passed, reasoning, latency_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(complaintId, dbModelId, question, answer.slice(0, 2000), score, passed ? 1 : 0, reasoning, latency);

  // Update complaint status
  db.prepare("UPDATE complaints SET status = ? WHERE id = ?").run(
    passed ? "exam_passed" : "exam_failed",
    complaintId
  );

  // Update benchmark with new score
  db.prepare(`
    INSERT INTO benchmark_results (model_id, question, answer, score, max_score, reasoning, latency_ms)
    VALUES (?, ?, ?, ?, 10, ?, ?)
  `).run(dbModelId, `[complaint] ${question}`, answer.slice(0, 2000), score, `Complaint re-exam: ${reasoning}`, latency);

  if (passed) {
    // Passed: clear cooldown, model can resume
    db.prepare(
      "DELETE FROM health_logs WHERE model_id = ? AND cooldown_until > datetime('now') AND status = 'complained'"
    ).run(dbModelId);

    logWorker("complaint", `${modelId} passed re-exam (${score}/10) — cleared cooldown`, "success");
  } else {
    // Failed: extend cooldown to 2 hours + score penalty
    const cooldownUntil = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO health_logs (model_id, status, error, cooldown_until, checked_at) VALUES (?, 'complained', ?, ?, datetime('now'))"
    ).run(dbModelId, `Re-exam failed: ${score}/10`, cooldownUntil);

    // Update nickname to reflect bad behavior
    const existingNames = (db.prepare("SELECT nickname FROM models WHERE nickname IS NOT NULL").all() as { nickname: string }[]).map(r => r.nickname);
    const newNickname = await generateNickname(
      modelId,
      provider,
      existingNames,
      `ถูกร้องเรียนว่า "${getCategoryLabel(category)}" และสอบตก (${score}/10) — ตั้งชื่อที่สะท้อนว่าถูกตำหนิ`
    );
    if (newNickname) {
      db.prepare("UPDATE models SET nickname = ? WHERE id = ?").run(newNickname, dbModelId);
      logWorker("complaint", `${modelId} renamed to "${newNickname}" after failing re-exam`, "warn");
    }

    logWorker("complaint", `${modelId} failed re-exam (${score}/10) — cooldown extended 2hr`, "warn");
  }

  // Check total daily complaints for blacklist
  const today = new Date().toISOString().slice(0, 10);
  const dailyCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM complaints WHERE model_id = ? AND created_at >= ?"
  ).get(dbModelId, `${today}T00:00:00`) as { cnt: number };

  if (dailyCount.cnt >= 10) {
    const cooldownUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO health_logs (model_id, status, error, cooldown_until, checked_at) VALUES (?, 'blacklisted', ?, ?, datetime('now'))"
    ).run(dbModelId, `Blacklisted: ${dailyCount.cnt} complaints today`, cooldownUntil);

    db.prepare("UPDATE complaints SET status = 'blacklisted' WHERE model_id = ? AND created_at >= ?")
      .run(dbModelId, `${today}T00:00:00`);

    logWorker("complaint", `${modelId} BLACKLISTED — ${dailyCount.cnt} complaints today`, "error");
  }
}

function getCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    wrong_answer: "ตอบผิด",
    gibberish: "พูดไม่รู้เรื่อง",
    wrong_language: "ตอบผิดภาษา",
    refused: "ปฏิเสธตอบ",
    hallucination: "แต่งเรื่อง",
    too_short: "ตอบสั้นเกินไป",
    irrelevant: "ตอบไม่ตรงคำถาม",
  };
  return labels[category] ?? category;
}

/**
 * Get complaint reputation score for a model (0-100, lower = more complaints)
 * Used by gateway to deprioritize models with many complaints
 */
export function getReputationScore(dbModelId: string): number {
  try {
    const db = getDb();
    const last7days = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const result = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'exam_failed' THEN 1 ELSE 0 END) as failed
      FROM complaints
      WHERE model_id = ? AND created_at >= ?
    `).get(dbModelId, last7days) as { total: number; failed: number };

    if (result.total === 0) return 100; // no complaints = perfect

    // Each complaint reduces reputation by 10, each failed exam by additional 10
    const penalty = result.total * 10 + result.failed * 10;
    return Math.max(0, 100 - penalty);
  } catch {
    return 100;
  }
}
