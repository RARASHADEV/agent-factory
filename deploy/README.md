# Deploying `af serve` (AF-53) on Hanuman

The AF HTTP service exposes the Agent Factory command surface over an authenticated,
tailnet-bound HTTP API. Full design: `docs/designs/AF-53-service.md`.

## Prerequisites
- **Node ≥ 22** (required for the built-in `node:sqlite` engine). Verify: `node --version`.
- Tailscale up (`tailscale ip -4` resolves the tailnet IPv4 the service binds to).
- `ENABLE_AF_53 = true` in `src/lib/constants.ts` (the AF-61 flag flip), then `npm run build`.

## One-time setup
1. **Config + secret** — `cp deploy/service.env.example ~/.af/service.env`, fill in:
   - `AF_SERVICE_SECRET` — `openssl rand -hex 32` (the bearer secret clients present).
   - `AF_SERVICE_BIND` — your tailnet IPv4 (`tailscale ip -4`).
   Then `chmod 600 ~/.af/service.env`. **Never commit this file.**
2. **Unit** — `sudo cp deploy/af-serve.service /etc/systemd/system/`. Adjust `ExecStart`
   to your `node` path (`which node`) and set `Environment=PATH=` to your login PATH so
   spawned agents find their tools.
3. `sudo systemctl daemon-reload && sudo systemctl enable --now af-serve.service`.

## Verify
```
B=http://<tailnet-ip>:4150 ; H="Authorization: Bearer $AF_SERVICE_SECRET"
curl -s -o /dev/null -w '%{http_code}\n' $B/health            # 401 (no auth)
curl -s -H "$H" $B/health                                     # {"ok":true,...,"capacity":20}
curl -s -H "$H" -d '{"kind":"agent","project":"x","objective":"y"}' $B/jobs   # 400 unknown project
curl -s -H "$H" "$B/audit?limit=5"                            # cross-plane journal
```

## Operate
- Status / logs: `systemctl status af-serve` · `journalctl -u af-serve -f`
- Restart: `sudo systemctl restart af-serve` (queued jobs resume; orphaned `running` → `failed`).
- Disable/roll back: `sudo systemctl disable --now af-serve`, and/or set `ENABLE_AF_53 = false`
  in `constants.ts` + `npm run build` to hard-disable the command.

## Endpoints (all require `Authorization: Bearer <secret>`)
- Execution (async, queued): `POST /jobs`, `GET /jobs/:id`, `GET /jobs`, `POST /jobs/:id/pause|resume`
- Query (sync): `GET /projects`, `/projects/:p/status`, `/projects/:p/tasks`, `/tasks/:ticket`, `/agents[/:slug]`, `/pipelines[/:ticket]`
- Mutation (sync): `POST /projects`, `POST /projects/:p/tasks`, `PATCH /tasks/:ticket`, `POST /agents/sync`, `POST /sync`
- Observability: `GET /audit`, `GET /health`
