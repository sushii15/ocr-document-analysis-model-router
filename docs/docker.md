# Docker deployment

The router ships with a production Dockerfile at `llm-router-mcp/Dockerfile` and a compose file at `../docker-compose.router.yml`.

## Build and run

```bash
npm run build
docker build -t llm-router-mcp:latest .
docker run -d --name llm-router -p 3100:3100 llm-router-mcp:latest
curl http://localhost:3100/health
```

## Docker Compose

From the repository root:

```bash
docker compose -f docker-compose.router.yml up -d --build
docker compose -f docker-compose.router.yml ps
```

The compose file mounts persistent router state at `/data/router-state` so decisions, outcomes, and learned scores survive container restarts.

## Runtime settings

Pass secrets at runtime, never bake them into the image.

```bash
ROUTER_API_KEY=change-me \
SUPABASE_URL=https://your-project.supabase.co \
SUPABASE_PUBLISHABLE_KEY=sb_publishable_... \
SUPABASE_DB_URL=postgresql://... \
V2_CREDENTIAL_ENCRYPTION_KEY=change-me \
docker compose -f docker-compose.router.yml up -d --build
```

Useful variables:

| Variable | Purpose |
|---|---|
| `ROUTER_API_KEY` | Optional HTTP API key for `/mcp` and dashboard routes. |
| `RATE_LIMIT_MAX` | Optional requests per window per IP. |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window. |
| `SUPABASE_URL` / `SUPABASE_SECRET_KEY` | Mirror router state to Supabase tables. |
| `SUPABASE_PUBLISHABLE_KEY` | Browser Supabase Auth client key. |
| `SUPABASE_DB_URL` | Apply migrations and mirror V2 profile, credential, run, event, and document intelligence data. |
| `AUTH_REQUIRED` | Set `true` in production to require Supabase Auth for V2 APIs. |
| `V2_CREDENTIAL_ENCRYPTION_KEY` | Encrypt user-owned BYOK provider credentials at rest. |
| `V2_STORAGE_BUCKET` | Private Supabase Storage bucket for uploaded documents. |
| `TESSERACT_CMD` | Optional path to Tesseract for image OCR. |
| `OPENAI_COMPATIBLE_BASE_URL` | Optional self-hosted OpenAI-compatible endpoint. |

## Production notes

- Keep `ROUTER_API_KEY` set in public deployments.
- Use Supabase or another shared store before running multiple router replicas.
- Users bring their own provider keys through V2 onboarding; keep encrypted credentials server-side only.
- Set `AUTH_REQUIRED=true` after Supabase Auth is configured.
- Rotate database credentials if they were ever shared outside your secret manager.
- Use `router_execute_request` with `dry_run=true` for deployment smoke tests that should not spend provider tokens.
