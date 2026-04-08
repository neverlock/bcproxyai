# BCProxyAI

An OpenAI-compatible LLM gateway that aggregates free-tier models from multiple providers, with automatic routing, health monitoring, and benchmarking.

## Stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 16.2.2 (App Router, Node.js) |
| UI | React 19.2.4 + Tailwind CSS v4 |
| Language | TypeScript 5 |
| Database | PostgreSQL 17 (via `postgres` driver + drizzle-orm) |
| Cache / State | Redis 7 (ioredis) |
| Reverse Proxy | Caddy 2 (in-compose) |
| Scheduler | node-cron |
| Testing | Vitest |

## Services

| Container | Role | Port |
|-----------|------|------|
| `bcproxyai` | Next.js app | internal :3000 |
| `caddy` | Reverse proxy + load balancer | **3334** → bcproxyai:3000 |
| `postgres` | Database | 5434 (host), 5432 (internal) |
| `redis` | Cooldowns, rate limits, state | 6382 (host), 6379 (internal) |

## Port map

| Port | Service |
|------|---------|
| 3333 | BCProxyAI via external Caddy (300s timeout) |
| 3334 | BCProxyAI via in-compose Caddy |
| 18790 | OpenClaw via Caddy (600s timeout) |
| 18791 | OpenClaw direct |

## Quick start

```bash
cp .env.example .env.local   # add provider API keys
docker compose up -d --build
curl http://localhost:3334/api/health
```

Dashboard: `http://localhost:3334`

OpenAI base URL: `http://localhost:3334/v1`

## Deploy workflow

```bash
rtk npx next build                   # verify 0 errors
rtk docker compose up -d --build
sleep 5 && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3334/
```

Container name: `bcproxyai-bcproxyai-1`

## Horizontal scaling

```bash
docker compose up -d --scale bcproxyai=2
```

Caddy load-balances across all healthy instances with round-robin and `/api/health` checks.

## Environment variables

Set in `.env.local` (picked up by `env_file` in compose):

```bash
OPENROUTER_API_KEY=sk-or-v1-...
GROQ_API_KEY=gsk_...
GOOGLE_AI_API_KEY=...
CEREBRAS_API_KEY=csk-...
SAMBANOVA_API_KEY=...
MISTRAL_API_KEY=...
KILO_API_KEY=...
GITHUB_API_KEY=ghp_...
FIREWORKS_API_KEY=...
COHERE_API_KEY=...
HF_API_KEY=hf_...
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_KEY=...
OLLAMA_BASE_URL=http://localhost:11434   # optional, defaults to this
```

`DATABASE_URL` and `REDIS_URL` are injected by docker-compose and do not need to be in `.env.local`.

Provider API keys can also be managed at runtime via `/api/setup`.

## Supported providers (13)

OpenRouter, Groq, Google AI, Mistral, Cerebras, SambaNova, Kilo, Ollama, GitHub Models, Fireworks, Cohere, Cloudflare Workers AI, Hugging Face.

## OpenAI-compatible endpoints

```
POST /v1/chat/completions     Smart-routed chat completions
GET  /v1/models               List all available models
GET  /v1/models/:model        Get a specific model
POST /v1/completions          Legacy text completions
POST /v1/embeddings           Text embeddings
POST /v1/images/generations   Image generation
POST /v1/audio/*              Audio (TTS, STT, translation)
POST /v1/moderations          Content moderation
```

### Virtual routing models

| Model | Behavior |
|-------|----------|
| `bcproxy/auto` | Best by benchmark score |
| `bcproxy/fast` | Lowest latency |
| `bcproxy/tools` | Best tool-calling support |
| `bcproxy/thai` | Best Thai language performance |
| `bcproxy/consensus` | Query 3 models, pick longest answer |

### Rate limiting

`POST /v1/chat/completions` is limited to 100 requests per 60 seconds per IP, enforced via Redis sliding window. Degrades gracefully if Redis is unavailable.

### Example

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3334/v1", api_key="dummy")
resp = client.chat.completions.create(
    model="bcproxy/auto",
    messages=[{"role": "user", "content": "สวัสดี"}],
)
print(resp.choices[0].message.content)
```

## Management API

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Health check (DB + Redis + worker) |
| `GET /api/status` | System overview |
| `GET /api/models` | Models with health/benchmark data |
| `GET /api/providers` | Provider list and status |
| `GET /api/leaderboard` | Model benchmark rankings |
| `GET /api/analytics` | Usage analytics |
| `GET /api/trend` | Score/latency trends (14 days) |
| `GET /api/uptime` | Model uptime statistics |
| `GET /api/gateway-logs` | Request audit trail |
| `GET /api/routing-stats` | Per-category routing performance |
| `GET /api/cost-optimizer` | Cost optimization data |
| `GET /api/cost-savings` | Cost savings report |
| `GET/POST /api/budget` | Daily token budget |
| `GET/POST /api/setup` | Provider API key management |
| `POST /api/complaint` | Submit quality complaint |
| `GET /api/events` | Real-time SSE event stream |
| `GET/POST /api/worker` | Worker status and manual trigger |

## Background worker

Runs automatically on startup (via `node-cron`, hourly):

1. **Scan** — discover new free models from all configured providers
2. **Health check** — ping each model, set cooldown on failure
3. **Benchmark** — score models on Thai/English questions using a judge model
4. **Auto-complaint** — detect bad responses and schedule retest

## Database schema (14 tables)

`models`, `health_logs`, `benchmark_results`, `gateway_logs`, `complaints`, `complaint_exams`, `routing_stats`, `events`, `token_usage`, `worker_state`, `worker_logs`, `cooldowns`, `api_keys`, `routing_decisions`

Schema is created automatically on first startup via `runMigrations()`.

## Testing

```bash
npm test              # vitest
npm run test:watch    # watch mode
```

Tests: `src/lib/worker/__tests__/`

## Dashboard

The web UI at `/` includes live sections: system status, provider grid, model leaderboard, chat panel, smart routing stats, trend charts, uptime tracker, cost optimizer, real-time event stream, complaints panel, gateway logs, and a Battle Theater animation driven by real request outcomes.

## Caddy reload (external)

If using the host-side Caddyfile (not the in-compose one):

```powershell
powershell -File "C:/Users/jatur/restart-caddy.ps1"
```
