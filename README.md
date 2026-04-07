# BCProxyAI — Smart AI Gateway

Gateway อัจฉริยะที่รวม AI ฟรีจาก **13 ผู้ให้บริการ** กว่า **200+ โมเดล** ไว้ในที่เดียว
ใช้งานผ่าน **OpenAI-compatible API** — เปลี่ยน base URL แล้วใช้ได้เลย ไม่ต้องแก้โค้ด

> **100% OpenClaw Compatible** — ดู [docs/API-GUIDE.md](docs/API-GUIDE.md) สำหรับคู่มือเรียกใช้จาก app อื่น

---

## คำเตือนด้านความปลอดภัย

> **ระบบนี้ไม่มี Authentication**
> ห้ามเปิดให้เข้าถึงจาก Internet — ใช้บน Local หรือ Network ภายในเท่านั้น
> ใครก็ตามที่เข้าถึงพอร์ตได้ จะใช้ได้ทันที

---

## สารบัญ

- [ภาพรวมระบบ](#ภาพรวมระบบ)
- [OpenAI API Compliance](#openai-api-compliance)
- [ผู้ให้บริการ AI ทั้ง 13 เจ้า](#ผู้ให้บริการ-ai-ทั้ง-13-เจ้า)
- [ติดตั้ง](#ติดตั้ง)
- [ตั้งค่า API Keys](#ตั้งค่า-api-keys)
- [เชื่อมต่อกับ OpenClaw](#เชื่อมต่อกับ-openclaw)
- [Virtual Models](#virtual-models)
- [Smart Routing](#smart-routing)
- [OpenClaw Compatibility](#openclaw-compatibility)
- [ฟีเจอร์ทั้งหมด](#ฟีเจอร์ทั้งหมด)
- [API Endpoints](#api-endpoints)
- [Dashboard](#dashboard)
- [แก้ไขปัญหา](#แก้ไขปัญหา)
- [ค่าใช้จ่าย](#ค่าใช้จ่าย)

---

## ภาพรวมระบบ

```
Application (OpenClaw / HiClaw / Python / curl / ...)
        |
        v
+-------------------------------+
|     BCProxyAI Gateway         |  http://localhost:3333/v1
|                               |
|  OpenAI-compatible API        |  POST /v1/chat/completions
|  - auto/fast/tools/thai       |  GET  /v1/models
|  - smart SQL routing          |  GET  /v1/models/{id}
|  - prompt compression         |  POST /v1/embeddings
|  - tools/vision normalize     |  POST /v1/audio/*
|  - retry + fallback (10x)     |  POST /v1/images/generations
|  - per-model cooldown         |
|  - OpenClaw 100% compatible   |
+-------------------------------+
        |
        v  (smart routing — เลือกตัวดีสุดจาก 13 เจ้า)
+-------+--------+--------+--------+--------+--------+
|  OR   | Kilo   | Google | Groq   | Cerebras| SN    |
+-------+--------+--------+--------+--------+--------+
| Mistral| Ollama | GitHub | FW    | Cohere | CF    | HF
+--------+--------+--------+-------+--------+-------+
```

**หลักการทำงาน:**
1. รับ request แบบ OpenAI format
2. ตรวจ capabilities (tools? images? json_schema?)
3. Query SQL → กรอง model ที่เหมาะสม → เรียงตาม `supports_tools` + `context_length` + latency
4. Normalize request (strip `reasoning`, fix `tool_calls.type`, แปลง `tool_call_id` ฯลฯ)
5. ส่งต่อไปยัง provider → ถ้า fail → retry ตัวถัดไป (สูงสุด 10 ครั้ง / total timeout 30s)
6. ตรวจ response quality → ส่งกลับในรูป OpenAI standard

---

## OpenAI API Compliance

ใช้แทน OpenAI API ได้เลย — เปลี่ยนแค่ `base_url`

| Endpoint | Method | รองรับ |
|----------|--------|--------|
| `/v1/chat/completions` | POST | stream + non-stream |
| `/v1/completions` | POST | legacy completions |
| `/v1/models` | GET | list ทุก model |
| `/v1/models/{id}` | GET | model detail |
| `/v1/embeddings` | POST | text embeddings |
| `/v1/moderations` | POST | content moderation |
| `/v1/audio/speech` | POST | text-to-speech |
| `/v1/audio/transcriptions` | POST | speech-to-text |
| `/v1/audio/translations` | POST | audio translation |
| `/v1/images/generations` | POST | image generation |

**Error format:** OpenAI standard `{ error: { message, type, param, code } }`

---

## ผู้ให้บริการ AI ทั้ง 13 เจ้า

ทุกเจ้าให้ใช้ **ฟรี** — ไม่มีค่าใช้จ่าย

| # | Provider | ENV Variable | ลิงก์สมัคร | หมายเหตุ |
|---|----------|-------------|-----------|----------|
| 1 | OpenRouter | `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) | รวม model จากหลายเจ้า |
| 2 | Kilo AI | `KILO_API_KEY` | [kilo.ai](https://kilo.ai) | AI Gateway ฟรี |
| 3 | Google AI | `GOOGLE_AI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Gemini Pro/Flash/Ultra |
| 4 | Groq | `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) | LPU inference เร็วมาก |
| 5 | Cerebras | `CEREBRAS_API_KEY` | [cloud.cerebras.ai](https://cloud.cerebras.ai/) | Wafer-scale เร็วสุด |
| 6 | SambaNova | `SAMBANOVA_API_KEY` | [cloud.sambanova.ai](https://cloud.sambanova.ai/) | RDU inference |
| 7 | Mistral AI | `MISTRAL_API_KEY` | [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) | Mixtral, Codestral |
| 8 | Ollama | ไม่ต้องใช้ key | [ollama.com/download](https://ollama.com/download) | รันบนเครื่องตัวเอง |
| 9 | GitHub Models | `GITHUB_MODELS_TOKEN` | [github.com/marketplace/models](https://github.com/marketplace/models) | AI จาก GitHub |
| 10 | Fireworks AI | `FIREWORKS_API_KEY` | [fireworks.ai/account/api-keys](https://fireworks.ai/account/api-keys) | Fast inference |
| 11 | Cohere | `COHERE_API_KEY` | [dashboard.cohere.com/api-keys](https://dashboard.cohere.com/api-keys) | Command R+ |
| 12 | Cloudflare AI | `CLOUDFLARE_API_TOKEN` | [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) | Workers AI (ต้องใส่ `CLOUDFLARE_ACCOUNT_ID` ด้วย) |
| 13 | HuggingFace | `HF_TOKEN` | [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) | Inference API |

---

## ติดตั้ง

### วิธีที่ 1: Docker (แนะนำ)

```bash
# 1. Clone
git clone https://github.com/jaturapornchai/bcproxyai.git
cd bcproxyai

# 2. สร้าง .env.local
cp .env.example .env.local
# แก้ไข .env.local — ใส่ API key ที่มี

# 3. Build + Run
docker compose build
docker compose up -d

# 4. เปิด Dashboard
# http://localhost:3333
```

### วิธีที่ 2: รันตรง

```bash
npm install
cp .env.example .env.local
# แก้ไข .env.local
npm run dev
# เปิด http://localhost:3000
```

### วิธีที่ 3: ตั้งค่าผ่าน Dashboard

เปิด Dashboard → กดปุ่ม **Setup** (icon เฟือง) → กรอก API Key ผ่านหน้าเว็บ → กด **บันทึก** → กด **Scan เลย!**

ระบบบันทึก key ลง database — ไม่ต้องแก้ไฟล์ ไม่ต้องรีสตาร์ท

---

## ตั้งค่า API Keys

มี 2 วิธี:

### วิธีที่ 1: ไฟล์ .env.local (ใช้เป็นหลัก)

```env
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxx
GROQ_API_KEY=gsk_xxxxxxxx
GOOGLE_AI_API_KEY=AIzaxxxxxxxx
CEREBRAS_API_KEY=csk-xxxxxxxx
SAMBANOVA_API_KEY=xxxxxxxx
MISTRAL_API_KEY=xxxxxxxx
GITHUB_MODELS_TOKEN=ghp_xxxxxxxx
FIREWORKS_API_KEY=fw_xxxxxxxx
COHERE_API_KEY=xxxxxxxx
CLOUDFLARE_API_TOKEN=xxxxxxxx
CLOUDFLARE_ACCOUNT_ID=xxxxxxxx
HF_TOKEN=hf_xxxxxxxx
KILO_API_KEY=xxxxxxxx
```

### วิธีที่ 2: ผ่าน Dashboard (ไม่ต้องรีสตาร์ท)

เปิด Setup Modal → วาง key → กดบันทึก → key เก็บใน DB → ใช้ได้ทันที

**ลำดับความสำคัญ:** `.env.local` > Database

---

## เชื่อมต่อกับ OpenClaw

```bash
# OpenClaw บน Docker
docker exec <openclaw-container> \
  openclaw onboard \
  --non-interactive --accept-risk \
  --auth-choice custom-api-key \
  --custom-base-url http://host.docker.internal:3333/v1 \
  --custom-model-id auto \
  --custom-api-key dummy \
  --custom-compatibility openai \
  --skip-channels --skip-daemon \
  --skip-health --skip-search \
  --skip-skills --skip-ui

# OpenClaw บนเครื่อง
openclaw onboard \
  --non-interactive --accept-risk \
  --auth-choice custom-api-key \
  --custom-base-url http://localhost:3333/v1 \
  --custom-model-id auto \
  --custom-api-key dummy \
  --custom-compatibility openai \
  --skip-channels --skip-daemon \
  --skip-health --skip-search \
  --skip-skills --skip-ui
```

---

## Virtual Models

ใช้ `model` field เลือกโหมด:

| Model ID | พฤติกรรม |
|----------|----------|
| `auto` | เลือกตัวดีสุดอัตโนมัติ (benchmark + routing stats) |
| `bcproxy/fast` | เร็วที่สุด (lowest latency) |
| `bcproxy/tools` | รองรับ tool calling |
| `bcproxy/thai` | เก่งภาษาไทย |
| `bcproxy/consensus` | ส่ง 3 models vote → เลือกคำตอบที่ดีที่สุด |
| `openrouter/model-id` | ระบุ provider + model ตรง |
| `groq/model-id` | ระบุ provider + model ตรง |

**ตัวอย่าง:**
```bash
curl http://localhost:3333/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "สวัสดี"}]}'
```

**ระบุ provider ผ่าน header:**
```bash
curl http://localhost:3333/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-BCProxy-Provider: groq" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "hello"}]}'
```

---

## Smart Routing

ใช้ **SQL ranking + real-time fallback** — ไม่ต้องรอ benchmark, model ใหม่ใช้ได้ทันที

### ขั้นตอน

```
Request เข้ามา
  ↓
detectRequestCapabilities() → { hasTools, hasImages, needsJsonSchema }
  ↓
SQL query model ที่ใช้งานได้:
  - กรอง: ไม่ใช่ embedding/TTS/image-gen
  - กรอง: ไม่ติด cooldown
  - กรอง: ถ้ามีรูป → supports_vision = 1
  ↓
ORDER BY:
  1. supports_tools = 1 (ถ้า request มี tools)
  2. context_length ≥ 128K → 32K → ที่เหลือ
  3. tier (large > small)
  4. latency (เร็วกว่าดีกว่า)
  ↓
Retry loop (สูงสุด 10 ครั้ง / total 30 วินาที):
  → forward → fail → cooldown model นั้น → retry ตัวถัดไป
```

### Cooldown Strategy

| Status | พฤติกรรม | Cooldown |
|--------|---------|---------|
| 200 | สำเร็จ | - |
| 400, 422 | Format ผิดเฉพาะ model นั้น | 1 นาที (per-model) |
| 413 | Request ใหญ่เกินไป | retry model context ใหญ่กว่า |
| 429 | Rate limited | API key cooldown 5 นาที |
| 500+ | Server error | 5 นาที (per-model) |
| Timeout | Cloud 15s, Ollama 60s | 1 นาที |

> **Per-Model Only:** ไม่มี provider-wide cooldown แล้ว — model หนึ่ง fail ไม่กระทบ model อื่นใน provider เดียวกัน
> **In-Memory:** Cooldown เก็บใน Map ในหน่วยความจำ ไม่ bloat DB

### Content Quality Check

- ตรวจ `<tool_call>` XML leak → retry ตัวอื่น
- Strip `<think>` reasoning blocks
- Empty / สั้นเกิน (< 3 chars) → retry

---

## OpenClaw Compatibility

Proxy normalize request format อัตโนมัติให้ทุก provider — client ไม่ต้องจัดการ

| สิ่งที่ Client ส่ง | สิ่งที่ Proxy ทำ |
|-------------------|-----------------|
| `max_completion_tokens` | แปลงเป็น `max_tokens` |
| `store: true` | ลบทิ้ง (OpenAI-only) |
| `stream_options` | ลบทิ้ง |
| `messages[].reasoning` | ลบทิ้ง (Mistral/Groq reject) |
| `messages[].reasoning_content` | ลบทิ้ง |
| `tool_calls[].type = ""` | บังคับเป็น `"function"` |
| `tool_calls: []` ว่าง | ลบ field ทิ้ง |
| Assistant ไม่มี content/tool_calls | เพิ่ม `content: " "` |
| `tool_call_id` ยาว/ผิดรูป | แปลงเป็น 9 chars สำหรับ Mistral |
| Tools + Images พร้อมกัน | Strip tools (incompatible) + cleanup orphan tool messages |
| Tools + model ไม่รองรับ | Strip tools + assistant.tool_calls + role=tool |
| Image URL + Ollama | Download → base64 |
| Messages > 30K tokens | Auto compress |

ดู [docs/API-GUIDE.md](docs/API-GUIDE.md) สำหรับรายละเอียดทั้งหมด

---

## ฟีเจอร์ทั้งหมด

| ฟีเจอร์ | รายละเอียด |
|---------|-----------|
| **Smart Routing** | SQL ranking ตาม tools support + context length + latency |
| **Auto Retry** | fail แล้ว retry ตัวอื่นอัตโนมัติ สูงสุด 10 ครั้ง / total 30s |
| **Per-Model Cooldown** | cooldown เฉพาะ model ที่ fail (ไม่ block ทั้ง provider) |
| **In-Memory Cooldown** | ใช้ Map ในหน่วยความจำ ไม่ bloat DB |
| **OpenClaw Normalize** | strip reasoning, fix tool_calls.type, แปลง tool_call_id อัตโนมัติ |
| **Consensus Mode** | ส่ง 3 models → vote เลือกคำตอบดีสุด |
| **Vision Support** | รองรับรูปภาพ + auto URL→base64 สำหรับ Ollama |
| **Tools + Vision Handler** | strip tools เมื่อมีรูป + cleanup orphan tool messages อัตโนมัติ |
| **Prompt Compression** | บีบอัด prompt ที่ยาวเกิน 30K tokens |
| **Quality Check** | ตรวจ XML tool_call leak, strip `<think>` blocks, retry empty response |
| **Complaint System** | ร้องเรียน model ที่ตอบไม่ดี |
| **Budget Control** | กำหนด daily token limit → ตัดที่ 95% |
| **Cost Optimizer** | วิเคราะห์ค่าใช้จ่ายและแนะนำทางประหยัด |
| **Provider Uptime** | สถิติ online/offline ของแต่ละ provider |
| **School Bell** | แจ้งเตือน real-time เมื่อมี model ใหม่ / provider ล่ม |
| **Analytics** | กราฟ usage, latency, provider distribution |
| **Web Setup** | กรอก API Key ผ่าน Dashboard ไม่ต้องรีสตาร์ท |
| **Speed Race** | เปรียบเทียบความเร็วระหว่าง provider |

---

## API Endpoints

### OpenAI-compatible (ใช้กับ client ทั่วไป)

| Method | Path | คำอธิบาย |
|--------|------|----------|
| POST | `/v1/chat/completions` | Chat (stream + non-stream) |
| POST | `/v1/completions` | Legacy completions |
| GET | `/v1/models` | รายการ model ทั้งหมด |
| GET | `/v1/models/{id}` | ข้อมูล model |
| POST | `/v1/embeddings` | Text embeddings |
| POST | `/v1/moderations` | Content moderation |
| POST | `/v1/audio/speech` | Text-to-Speech |
| POST | `/v1/audio/transcriptions` | Speech-to-Text |
| POST | `/v1/audio/translations` | Audio translation |
| POST | `/v1/images/generations` | Image generation |

### Dashboard API (internal)

| Method | Path | คำอธิบาย |
|--------|------|----------|
| GET | `/api/status` | สถานะ worker + stats |
| GET | `/api/models` | รายการ model พร้อม health/benchmark |
| GET | `/api/leaderboard` | ผลสอบ (ranking + category scores) |
| GET | `/api/providers` | สถานะ 13 providers + key status |
| GET | `/api/analytics` | ข้อมูล charts |
| GET | `/api/gateway-logs` | log request/response ล่าสุด |
| GET | `/api/routing-stats` | สถิติ smart routing |
| GET | `/api/trend` | กราฟพัฒนาการ model |
| GET | `/api/uptime` | สถิติ uptime provider |
| GET | `/api/cost-optimizer` | วิเคราะห์ค่าใช้จ่าย |
| GET | `/api/cost-savings` | สรุปยอดประหยัด |
| GET | `/api/events` | event log (school bell) |
| GET | `/api/health` | health check (for monitoring) |
| POST | `/api/worker` | trigger worker scan ทันที |
| POST | `/api/complaint` | ร้องเรียน model |
| GET/POST | `/api/budget` | ตั้งค่า daily budget |
| GET/POST | `/api/setup` | จัดการ API key ผ่านเว็บ |

---

## Dashboard

เปิดที่ `http://localhost:3333` — มี 15 section:

| Section | คำอธิบาย |
|---------|----------|
| ครูใหญ่ | สถานะ worker, ปุ่ม scan, countdown |
| ผู้ให้บริการ | 13 providers พร้อมสถานะ key + model count |
| ผลงาน | Model performance — usage stats จากการทำงานจริง |
| วิ่งแข่ง | Speed Race — เปรียบเทียบ latency ทุก provider |
| สมุดพก | Analytics charts |
| นักเรียน | Model grid — available / cooldown |
| แชท | Chat UI ทดสอบพูดคุยกับ model |
| จัดห้อง | Smart routing stats |
| พัฒนาการ | กราฟ trend latency/usage ตามเวลา |
| ขาด/ลา | Provider uptime |
| ค่าเทอม | Cost optimizer |
| ระฆัง | School bell alerts |
| ร้องเรียน | Complaint system |
| จดงาน | Gateway logs (LIVE) — request/response real-time |
| บันทึกครู | Worker logs |

**Setup Modal:** กดปุ่ม Setup → กรอก API Key → กดบันทึก → กด Scan

---

## Worker อัตโนมัติ

ทำงานทุก **1 ชั่วโมง** (หรือกด trigger ด้วยมือ):

1. **Scan** — ค้นหา model จาก 13 providers
2. **Health Check** — ทดสอบว่า model ยังใช้ได้
3. **Cleanup** — ลบ log เก่า

> **ไม่มี Benchmark แล้ว** — Model ใหม่ใช้ได้ทันทีโดยไม่ต้องสอบ วัดผลจากการทำงานจริง (gateway_logs)
> ถ้า model ไหนตอบไม่ดี → cooldown อัตโนมัติ แล้ว fallback ตัวอื่น

---

## แก้ไขปัญหา

### 503 ซ้ำๆ — "All models failed after retries"
- ตรวจว่ามี API key อย่างน้อย 1 เจ้า
- ตรวจ `จดงาน` ใน Dashboard ว่า request ที่ fail format ผิดหรือไม่
- ดู Docker logs: `docker logs bcproxyai-bcproxyai-1 --tail 50`
- ถ้า error ซ้ำเดิมทุก provider → format ผิด ต้องเพิ่ม normalization

### OpenClaw 422/400 ทุก request
- เช็ค field ที่ provider reject ใน Docker logs (`[RETRY] ... → HTTP 422`)
- เพิ่ม normalization ใน `forwardToProvider()` ที่ [src/app/v1/chat/completions/route.ts](src/app/v1/chat/completions/route.ts)
- ตัวอย่าง field ที่เจอบ่อย: `reasoning`, `tool_calls.type`, `store`, `stream_options`

### Vision ไม่ทำงาน
- ต้องมี model ที่ `supports_vision = 1` ใน DB
- ถ้าส่งรูป + tools พร้อมกัน → tools จะถูก strip อัตโนมัติ
- OpenRouter free models ส่วนใหญ่ไม่รองรับ vision จริง

### Docker: port conflict
- เปลี่ยน port ใน `docker-compose.yml`: `"3334:3000"` แทน `"3333:3000"`

---

## ค่าใช้จ่าย

**$0** — ทุก provider ให้ใช้ฟรี

| Provider | ค่าใช้จ่าย | หมายเหตุ |
|----------|-----------|----------|
| OpenRouter | ฟรี (free models) | มี paid models ด้วย แต่ระบบใช้แค่ :free |
| อีก 11 เจ้า | ฟรี | free tier ทั้งหมด |
| Ollama | ฟรี | รันบนเครื่องตัวเอง (ใช้ GPU/CPU) |
| BCProxyAI | ฟรี | open source |

---

## Tech Stack

| ส่วน | เทคโนโลยี |
|------|-----------|
| Framework | Next.js 16 + TypeScript |
| UI | React 19 + Tailwind CSS v4 |
| Database | SQLite (better-sqlite3) + WAL mode |
| Container | Docker + Alpine |
| Test | Vitest |

---

## License

MIT
