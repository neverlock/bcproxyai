<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:bcproxyai-rules -->
# BCProxyAI project rules

## Documentation = current state only
When writing/rewriting README.md, AGENTS.md, or any docs file: describe ONLY what exists right now. Never include "previously / migrated from / what's new / changelog / version history". If something was removed, just don't mention it. Treat every doc rewrite as if the reader has never seen the project. Changelogs belong in `git log`, not docs.

**Why:** Mixing history with current state confuses readers. The user explicitly set this as a permanent rule.

## Port map (do not confuse)
| Port | Service |
|------|---------|
| 3333 | BCProxyAI via external Caddy (300s timeout) |
| 3334 | BCProxyAI via in-compose Caddy (load balanced) |
| 5434 | Postgres (bcproxyai compose service) |
| 6382 | Redis (bcproxyai compose service) |
| 18790 | OpenClaw via Caddy (600s timeout) |
| 18791 | OpenClaw direct (Docker) |

The bcproxyai container exposes only internal port 3000; host traffic routes through the in-compose `caddy` service. Scale with `docker compose up -d --scale bcproxyai=N`.

## Deploy workflow
```bash
rtk npx next build           # verify 0 errors first
rtk docker compose up -d --build
sleep 5 && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3334/
```
Container name: `bcproxyai-bcproxyai-1`. OpenClaw container: `openclaw-bcproxy-test`.

## Verification before "done"
Never claim work is complete without:
1. Build returning 0 errors (`rtk npx next build`)
2. HTTP 200 from the affected route (curl)
3. Container `Up` (not `Restarting` or `Exited`)

## Caddy reload
Caddyfile changes need: `powershell -File "C:/Users/jatur/restart-caddy.ps1"`. Caddy logs at `caddy.log` / `caddy.err.log` (gitignored).
<!-- END:bcproxyai-rules -->
