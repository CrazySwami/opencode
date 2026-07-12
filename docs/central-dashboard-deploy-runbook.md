# OpenCode Central Dashboard — Operator Deploy Runbook

Audited from code on 2026-07-11. Every env var / port / path below is cited as
`file:line`. This is documentation only — no deploy, no infra changes were made
while producing it.

Scope: the `opencode` monorepo (this repo) serving the main app + API, plus
three standalone daemons it proxies from sibling repos:
`token-maxing`, `cross-cli-registry` (fleet service), `auto-improve`. A fourth
proxied service, the Open Design daemon (`open-design` repo, port 7456), is
covered where the opencode side touches it, but its own deploy lifecycle lives
in that repo (not one of the "3 standalone daemons" this runbook operates).

---

## 1. Overview & topology

```
                         ┌────────────────────────────────────────────┐
                         │  opencode server (this repo)                │
 browser ── HTTPS ──────▶│  127.0.0.1:8299 (fixed convention; CLI      │
   (Cloudflare tunnel /  │  default port is RANDOM unless --port set)  │
    Access, on the live  │  serves SolidJS app at "/" + JSON API       │
    box only)            │  GET /global/health                        │
                         └───────────────┬──────────────────────────┘
                                          │ proxies (each degrades to
                                          │ {ok:false} if daemon is down)
        ┌───────────────┬─────────────────┼─────────────────┬───────────────┐
        ▼               ▼                 ▼                 ▼               ▼
 token-maxing    fleet service      auto-improve      Open Design      image hub
 127.0.0.1:8787  127.0.0.1:8788     127.0.0.1:8789    127.0.0.1:7456   127.0.0.1:8766
 repo:           repo:              repo:              repo:            (env var only;
 token-maxing/   cross-cli-registry/ auto-improve/     open-design/     no sibling repo
                                                                         found in this
                                                                         audit)
 gate: POST      gate: POST         gate:              own lifecycle:  gate: n/a —
 /switch needs   /continue needs    AUTO_IMPROVE_       `pnpm tools-dev  read-only
 OPENCODE_        FLEET_DRIVE_       ENABLED (daemon-    start|stop|...` proxy target
 TOKEN_MAXING_    ENABLED=1          side, default OFF)  or Docker
 TOKEN                               — default: dry-run  compose
 (server-side                        only, no PR/commit
 secret)
```

| Service | Port (default) | Repo | Backs (opencode tab/route) | Default gate state |
|---|---|---|---|---|
| opencode server (app+API) | `127.0.0.1:8299` fixed convention on the live box; CLI default is a random port unless `--port` is passed | this repo | SolidJS app at `/`, all `/experimental/*` routes, `/global/health` | Unsecured (HTTP Basic) unless `OPENCODE_SERVER_PASSWORD` is set |
| token-maxing daemon | `127.0.0.1:8787` | `token-maxing/` | Token-Maxing tab (`/experimental/token-maxing/usage`, `/switch`) | Usage read: open. Account switch/failover: refused (403) unless `OPENCODE_TOKEN_MAXING_TOKEN` set |
| fleet service | `127.0.0.1:8788` | `cross-cli-registry/` | Agent Fleet tab (`/experimental/fleet/sessions`, home-chat continue) | Session listing: open. Drive/continue (spawns a paid CLI): 403 unless the **daemon's own** `FLEET_DRIVE_ENABLED=1` |
| auto-improve daemon | `127.0.0.1:8789` | `auto-improve/` | Auto-Improve tab (`/experimental/auto-improve/status`) | Status read: open. Live git/gh actions: dry-run unless the **daemon's own** `AUTO_IMPROVE_ENABLED=1` |
| Open Design daemon | `127.0.0.1:7456` | `open-design/` (own repo, own lifecycle) | mcp-registry, skills, home-chat, open-design tabs | Independent app; opencode only proxies to it |
| Image hub | `127.0.0.1:8766` | not found as a sibling repo in this audit | Image-gen tab (`/experimental/image/*`) | n/a — opencode only reads `OPENCODE_IMAGE_HUB_URL`; no daemon-lifecycle code found here |

All four proxied-daemon reads (token-maxing usage, fleet sessions, auto-improve
status, plus browser-use bridge) follow the same pattern: `fetch` with a short
timeout, and on any network failure or non-2xx response return
`{ ok: false, error: "<daemon> offline", ... }` instead of throwing — confirmed
at `packages/opencode/src/server/routes/instance/httpapi/server.ts:3147-3287`.

**Correction to the brief's seed:** the seed described Cloudflare Access
verification as "the mechanism for safely exposing the app publicly." In code,
Cloudflare Access JWT verification (`server.ts:3882-4127`) gates **only the
live-browser / browser-use control surface**, not the app as a whole. The
app-wide public-exposure gate is HTTP Basic Auth via `OPENCODE_SERVER_PASSWORD`
/ `OPENCODE_SERVER_USERNAME` (`packages/opencode/src/server/auth.ts`,
`packages/opencode/src/server/routes/instance/httpapi/middleware/authorization.ts`).
See Sections 5 and 6.

---

## 2. Prerequisites

- **Runtime:** Bun (the server, tests, and build all run under `bun`; no `uv`
  or plain-Node runtime is used for this repo's own server — Node appears only
  as the runtime for the three sibling daemons, two of which use `tsx`/Node and
  one of which uses `node --experimental-transform-types`).
- **Sibling daemons:**
  - `token-maxing/`: `npm install && npm run dev` (tsx watch) or `npm start`
    (`token-maxing/package.json` scripts; confirmed via
    `/Users/alfonso/Documents/GitHub/token-maxing/README.md:47-67`).
  - `cross-cli-registry/`: `pnpm install && pnpm dev:service` (`tsx bin/fleet-service.ts`)
    (`/Users/alfonso/Documents/GitHub/cross-cli-registry/README.md:19-23`).
  - `auto-improve/`: `pnpm install && pnpm serve` (Node ≥20,
    `--experimental-transform-types`) (`/Users/alfonso/Documents/GitHub/auto-improve/README.md:64-77`).
- **Build the opencode app+API:**
  - Local dev (no compiled binary, hot server + hot UI): from repo root,
    `bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 8299 --hostname 127.0.0.1`
    (root `package.json:9` defines the equivalent `dev` script;
    `packages/opencode/src/cli/cmd/serve.ts:6-23` is the `serve` command
    implementation). Separately, `bun --cwd packages/app dev` runs the SolidJS
    UI dev server (Vite) — see the personal launcher
    `/Users/alfonso/Documents/GitHub/opencode/dev-local.sh` for the exact
    pattern in use (ports 8399/3000 in that script's local convention).
  - Release/embedded build: `bun run --cwd packages/opencode build` runs
    `packages/opencode/script/build.ts`, which first builds the SolidJS app
    (`bun run --cwd <repo>/packages/app build`, `script/build.ts:29-31`) and
    embeds its `dist/` output into the compiled `opencode` binary as
    `opencode-web-ui.gen.ts` (`script/build.ts:27-49`). If no embedded UI is
    present (`--skip-embed-web-ui`) the server instead proxies UI requests to
    `https://app.opencode.ai` (`packages/opencode/src/server/shared/ui.ts:9,74-90`)
    — worth knowing: a misconfigured/partial build silently falls back to
    fetching the **public hosted UI**, not local files.
- **Serving:** `opencode serve` (network options: `--port` default `0`/random,
  `--hostname` default `127.0.0.1`, `--mdns`, `--cors`) —
  `packages/opencode/src/cli/network.ts:6-30`. On first run without
  `OPENCODE_SERVER_PASSWORD` the CLI prints `Warning: OPENCODE_SERVER_PASSWORD
  is not set; server is unsecured.` (`packages/opencode/src/cli/cmd/serve.ts:15-16`).

---

## 3. Environment variables

### 3.1 Daemon base URLs

| Var | Default | Read at | Effect |
|---|---|---|---|
| `OPENCODE_TOKEN_MAXING_URL` | `http://127.0.0.1:8787` | `server.ts:3149`, `server.ts:3180` | Base URL the Token-Maxing tab proxies `/usage` and `/switch` to |
| `OPENCODE_TOKEN_MAXING_TOKEN` | unset (switch refused) | `server.ts:3181` | Operator secret forwarded as `x-operator-token` to the daemon's `/switch`; **never sent to the browser** |
| `OPENCODE_FLEET_URL` | `http://127.0.0.1:8788` | `server.ts:1246`, `server.ts:3221` | Base URL for the Agent Fleet tab (`/sessions`, home-chat continue) |
| `OPENCODE_AUTO_IMPROVE_URL` | `http://127.0.0.1:8789` | `server.ts:3254` | Base URL for the Auto-Improve tab's `/status` |
| `OPENCODE_OD_URL` | `http://127.0.0.1:7456` | `server.ts:246` | Open Design daemon base (home-chat default agent path) |
| `OD_DAEMON_URL`, `OPENCODE_OPEN_DESIGN_DAEMON_URL`, `OPENCODE_OPEN_DESIGN_URL` | fallback chain, no hardcoded default in this chain (falls through to `undefined`) | `server.ts:5361-5363`, `tool/open-design.ts:94-96` | Alternate/legacy names for the Open Design daemon URL, checked in this order |
| `OD_API_TOKEN`, `OPENCODE_OPEN_DESIGN_TOKEN` | unset | `server.ts:5370`, `tool/open-design.ts:98` | Bearer token for the Open Design daemon |
| `OPENCODE_OPEN_DESIGN_PUBLIC_URL` | `https://design.hustletogether.com` | `server.ts:5366` | Public URL surfaced to the UI for the Open Design iframe |
| `OPENCODE_OPEN_DESIGN_PROXY` | unset (`!== "0"` → proxy ready) | `server.ts:5375` | Set to `"0"` to disable the open-design proxy readiness flag |
| `OPENCODE_OD_AGENT` | `"codex"` | `server.ts:1121` | Default coding-agent engine used for home-chat |
| `OPENCODE_IMAGE_HUB_URL` | `http://127.0.0.1:8766` | `tool/image-gen.ts:35` | Base URL for the local image-generation hub proxied by the Image tab. **No sibling repo for this daemon was found in this audit** — it is a separate local service (per operator's own notes) outside the scope of the three daemon repos named in this task |
| `OPENCODE_BROWSER_USE_URL` | `http://127.0.0.1:8768` | `server.ts:4991`, `tool/browser-use.ts:216` | Base URL for the browser-use automation bridge |
| `OPENCODE_CLI_RESOURCES_PROVIDER_URL` | `http://127.0.0.1:8299/provider` | `tool/cli-resources.ts:105` | Self-referential: CLI-resources status calls back into the opencode server's own `/provider` endpoint — this hardcodes the 8299 convention |
| `OPENCODE_BROWSER_OPTIMIZED_VIEWER_URL` | `http://127.0.0.1:7458` | `server.ts:3802` | Optimized browser-viewer companion service URL |
| `OPENCODE_LIVE_BROWSER_NOVNC_URL` | `http://127.0.0.1:6080` | `server.ts:3799` | noVNC endpoint for live-browser streaming |

### 3.2 Security gates / feature flags (opencode side)

| Var | Default | Read at | Effect |
|---|---|---|---|
| `OPENCODE_ROUTINES_RUN_ENABLED` | unset → **OFF** | `routines.ts:902` | Second (topmost) gate: manual **and** scheduled routine runs refuse to execute unless this is exactly `"1"`. Also gates the 30s scheduler tick (`routines.ts:1000`, `runRoutine` layer-1 check at `routines.ts:677-684`) |
| `OPENCODE_ROUTINES_MUTATIONS` | unset → **falls back to hostname check** | `routines.ts:897-898` | First gate. If explicitly set, `"1"` = mutations allowed, anything else = disallowed. If **unset**, mutations are enabled only when `OPENCODE_HOSTNAME === "code.hustletogether.com"` — i.e., mutations quietly turn on if that specific hostname env var is set, even without touching this var directly |
| `OPENCODE_ROUTINES_OPERATOR_TOKEN` | unset (no token requirement beyond outer server auth) | `routines.ts:909` | Optional operator token the routines HTTP surface can require on `run` calls |
| `OPENCODE_ROUTINES_HOME` | `$XDG_DATA_HOME/opencode-routines` or `~/.local/share/opencode-routines` | `routines.ts:885` | Storage dir for `routines.json` and run logs |
| `OPENCODE_HOSTNAME` | `"code.hustletogether.com"` (only as a *default value* used for display; but see routines gate above, which reads the raw env var, not the default) | `server.ts:5020`, `routines.ts:898`, `account-status.ts:330` | Multi-purpose: labels the live env in status endpoints, **and** is the hidden second input to the routines-mutations gate |
| `OPENCODE_SECRETS_ENABLED` | unset → **OFF** | `secrets/store.ts:91-95` | Gates `setSecret`/`deleteSecret` (mutations). Metadata listing and env-injection (`secretsEnvFor`) are always available regardless of this flag — see 3.4 |
| **`FLEET_DRIVE_ENABLED`** | unset → OFF | daemon-side only: `cross-cli-registry/bin/fleet-service.ts:19`, `cross-cli-registry/src/service/server.ts:46-64` | **Correction:** this is NOT read by opencode itself. It is the fleet daemon's own env var; opencode's proxy at `server.ts:1244-1262` just forwards the daemon's 403 through with a hint message |
| **`AUTO_IMPROVE_ENABLED`** | unset → OFF (dry-run) | daemon-side only: `auto-improve/README.md:79-89` | Not read by opencode. Confirmed only in the `auto-improve` repo |

### 3.3 Tracing (LangSmith / OpenTelemetry)

Module: `packages/core/src/observability/langsmith.ts`.

| Var | Default | Read at | Effect |
|---|---|---|---|
| `LANGSMITH_TRACING` | unset → **OFF** | `langsmith.ts:64` | Must be `"1"` or `"true"` |
| `LANGSMITH_API_KEY` | unset → **OFF** | `langsmith.ts:63` | Presence-only check; value itself is never logged or returned by any status endpoint (`langsmith.ts:8-9`). Tracing is enabled only when **both** `LANGSMITH_TRACING` is truthy **and** this key is present (`langsmith.ts:67`) |
| `LANGSMITH_PROJECT` | unset | `langsmith.ts:65` | Non-secret label only |
| `OPENCODE_TRACE_RECORD_CONTENT` | unset → **OFF** | `langsmith.ts:84` | Controls `recordInputs`/`recordOutputs` on the AI SDK's telemetry (`agent/agent.ts:398-400`, `session/llm.ts:354-356`). The AI SDK itself defaults these to **TRUE**, so opencode explicitly overrides to OFF; setting this to `"1"` ships full prompt/response bodies (including any pasted secrets/PII) to whatever OTLP endpoint is configured |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | `control-plane/workspace.ts:534`, `flag.ts:16` | Where spans actually go (LangSmith accepts OTLP directly at `https://api.smith.langchain.com/otel`) |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | `control-plane/workspace.ts:533`, `flag.ts:17` | Exporter auth headers, e.g. `x-api-key=<LangSmith key>,Langsmith-project=<project>` |
| `OTEL_RESOURCE_ATTRIBUTES` | unset | `control-plane/workspace.ts:535` | Passed through to spawned workspace processes |

Note: `LANGSMITH_TRACING`/`LANGSMITH_API_KEY` only flip the AI SDK's
`experimental_telemetry.isEnabled` flag — they do not by themselves ship spans
anywhere. An actual OTLP exporter still needs `OTEL_EXPORTER_OTLP_ENDPOINT` /
`_HEADERS` configured (see the extensive comment at `langsmith.ts:21-44`).

### 3.4 Secrets store

Module: `packages/opencode/src/secrets/store.ts`. AES-256-GCM, per-entry
IV+tag, master key cached in-process.

| Var | Default | Read at | Effect |
|---|---|---|---|
| `OPENCODE_SECRETS_DIR` | `$XDG_DATA_HOME/opencode-secrets` or `~/.local/share/opencode-secrets` | `store.ts:71-76` | Overrides the store directory |
| `OPENCODE_SECRETS_KEY` | unset → key is generated and persisted | `store.ts:124-133` | Base64, must decode to exactly 32 bytes; if absent, a key is generated with `crypto.randomBytes(32)` and written once to `<store>/.master.key` at mode `0600` (`store.ts:152-172`) |
| `OPENCODE_SECRETS_ENABLED` | unset → **OFF** | `store.ts:91-95` | Gates mutation endpoints only (see 3.2) |

**`secretsEnvFor(scope)`** (`store.ts:318-331`) is the sole internal accessor
that decrypts values; it is never routed over HTTP (`store.ts:314-317`).
`packages/opencode/src/tool/shell.ts:434-464` is the consumer: every shell-tool
invocation's env is built as
`{ ...process.env, ...secretsEnv, ...workspaceEnv, ...extra.env }`
(`shell.ts:458-463`), where `secretsEnv` is populated only if
`Secrets.secretsEnabled()` is true, and is filtered against a
`SECRET_ENV_DENYLIST` (`PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`,
`DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `NODE_OPTIONS`, `BASH_ENV`,
`ENV`, `SHELLOPTS`, `IFS`, `PROMPT_COMMAND` — `shell.ts:29-41`) so a stored
secret can never override an exec-influencing variable.

### 3.5 Cloudflare Access (scoped to live-browser exposure — see correction in §1)

Module: `packages/opencode/src/server/routes/instance/httpapi/server.ts:3838-4131` (uses `jose`'s `createRemoteJWKSet`/`jwtVerify`).

| Var | Default | Read at | Effect |
|---|---|---|---|
| `OPENCODE_LIVE_BROWSER_EXPOSE` | unset → **enabled** (`!== "0"`) | `server.ts:3838` | **Fails open**: live-browser viewing/control is exposed by default; set to `"0"` to disable it entirely |
| `OPENCODE_LIVE_BROWSER_REQUIRE_ACCESS` | unset → **OFF** (`=== "1"` required to turn on) | `server.ts:3839` | If OFF (default) and Cloudflare Access isn't configured or no valid JWT is presented, the request is still allowed through in `"live-public-warning"` mode (`server.ts:4066-4099`) rather than blocked — this is the actual security-relevant default, not just "Cloudflare Access exists" |
| `OPENCODE_CLOUDFLARE_ACCESS_AUD` | unset | `server.ts:3882` | Access Application Audience (AUD) tag checked against the JWT's `aud` claim |
| `OPENCODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN` | unset | `server.ts:3883-3888` | Cloudflare team domain; normalized to `https://<domain>` and used both as JWT `issuer` and to build the JWKS certs URL `${teamDomain}/cdn-cgi/access/certs` (`server.ts:4104-4107`) |
| `OPENCODE_CLOUDFLARE_ACCESS_ALLOWED_EMAILS` | unset (no allowlist restriction beyond a valid Access session) | `server.ts:3889-3893` | Comma-separated, lower-cased; if non-empty, the verified JWT's email must be in this list or the request is blocked as `"invalid-cloudflare-token"` (`server.ts:4113-4118`) |

When a token **is** presented, verification is real: `jwtVerify(token, jwks,
{ audience, issuer })` against Cloudflare's live JWKS endpoint
(`server.ts:4104-4112`), not just a header presence check.

**App-wide public exposure gate (separate mechanism):**

| Var | Default | Read at | Effect |
|---|---|---|---|
| `OPENCODE_SERVER_PASSWORD` | unset → **no auth required** | `packages/core/src/flag/flag.ts:32`, `packages/opencode/src/server/auth.ts:19-24` | If set, the entire HTTP API (except paths matched by `isPublicUIPath`) requires HTTP Basic Auth (`middleware/authorization.ts:101-116`, `:118-132`) |
| `OPENCODE_SERVER_USERNAME` | `"opencode"` | `packages/core/src/flag/flag.ts:33`, `server/auth.ts:18` | Basic-auth username paired with the password above |

**Not found in this codebase:** the seed mentioned an "MCP gateway (docker mcp,
127.0.0.1:8811, bearer)" that should stay loopback/behind Access. A repo-wide
search (`grep -rn "8811"`, `"docker mcp"`, `"mcp-gateway"`) across this repo
and all three sibling daemon repos found **no matches** other than unrelated
hex color codes in SVG assets. Either this component lives entirely outside
these four repos (e.g., a host-level Docker Desktop MCP Toolkit gateway) or it
is not yet wired into this codebase. Treat it as **unconfirmed** — if it exists
on the operator's box, it must be secured at the infra layer, not via any
env var documented here.

### 3.6 Appendix — browser / mac-view / codex-multi-auth / misc (compact)

These are read in `packages/opencode/src/server/routes/instance/httpapi/server.ts`
and `packages/opencode/src/tool/*.ts`. Not core to the daemon-proxy dashboard,
listed for completeness per the audit instructions.

| Var | Default | Purpose |
|---|---|---|
| `OPENCODE_MAC_VIEW_URL` | unset | Mac-view feed base URL (`server.ts:3496,5499`) |
| `OPENCODE_MAC_VIEW_SETTINGS_HOME` | `~/.local/share/opencode-mac-view` | Mac-view settings dir (`server.ts:5512-5513`) |
| `OPENCODE_MAC_VIEW_FPS` / `_WIDTH` / `_QUALITY` / `_BITRATE` / `_TRANSPORT` | `30` / `1280` / `8` / `6000` / n/a | Mac-view stream tuning (`server.ts:5539-5543,5565`) |
| `OPENCODE_MAC_RESOURCE_HOST` | `"alfonso-mac"` | Resource-status hostname label (`server.ts:2993`, `tool/resource-status.ts:157`) |
| `OPENCODE_MAC_NODE_PATH` | `/opt/homebrew/bin/node` | Node path for Mac resource probes (`tool/resource-status.ts:158`) |
| `OPENCODE_BROWSER_HOME` | `~/.local/share/opencode-browser` | Browser profile root (`tool/browser.ts:212`, `tool/file-browser.ts:182`) |
| `OPENCODE_FILE_VIEW_ROOTS` | none | Extra allowed file-browse roots, `path.delimiter`-separated (`server.ts:3648`, `tool/file-browser.ts:180`) |
| `OPENCODE_FILE_BROWSER_ROOT` | none | Explicit single browse root override (`server.ts:3679`, `tool/file-browser.ts:189`) |
| `OPENCODE_DEV_ROOT` | `/home/dev/repos` | Repos root for file-browse/resource tools (`server.ts:3652,3700`, `tool/file-browser.ts:183`, `tool/resource-status.ts:193`) |
| `OPENCODE_RESOURCE_DISK_PATHS` | `[$OPENCODE_DEV_ROOT, "/"]` | Disk-usage probe paths, `:`-separated (`tool/resource-status.ts:192-193`) |
| `OPENCODE_LIVE_BROWSER_DISPLAY` | `":99"` | X display for the live browser (`server.ts:3783`) |
| `OPENCODE_LIVE_BROWSER_FRAME_MS` | `100` | Frame interval (`server.ts:3786`) |
| `OPENCODE_LIVE_BROWSER_HOME` | `~/.local/share/opencode-live-browser` | Live-browser profile home (`server.ts:3792-3793`) |
| `OPENCODE_LIVE_BROWSER_DEBUG_PORT` | `9224` | Chrome remote-debug port (`server.ts:3797`) |
| `OPENCODE_LIVE_BROWSER_BIN` | `google-chrome` | Browser binary (`server.ts:4458`) |
| `OPENCODE_LIVE_BROWSER_EXTENSIONS` / `_LASTPASS` / `_PERSISTENT_AUTH` | unset (OFF) | Live-browser profile feature toggles, gated additionally behind the Cloudflare-Access boundary (`server.ts:3935-3939`) |
| `OPENCODE_BROWSER_NOVNC_QUALITY` / `_COMPRESSION` / `_MODE` | `4` / n/a / `"fast"` | noVNC tuning (`server.ts:4180-4306`) |
| `OPENCODE_BROWSER_USE_PERSISTENT_PROFILE` / `_EXTENSIONS` / `_LASTPASS` | unset (OFF) | Browser-use bridge profile toggles (`tool/browser-use.ts:220-222`) |
| `OPENCODE_MULTI_AUTH_PROFILE` | `"guard22-codex-multi-auth"` | Codex multi-account profile name (`server.ts:1121` area, `1342,1500...`) |
| `OPENCODE_SHOW_BASE_OPENAI_WITH_MULTI_AUTH` / `OPENCODE_HIDE_BASE_OPENAI_WITH_MULTI_AUTH` | unset | Multi-auth provider-list toggles (`server.ts:1628-1629`) |
| `OPENCODE_CODEX_MULTI_AUTH_SCRIPT` | unset | Path to the codex multi-auth helper script (`server.ts:1342`) |
| `OPENCODE_CONVERSATION_EXPORT_SCRIPT` / `OPENCODE_STATE_EXPORT_DIR` | n/a / `/home/dev/.local/share/opencode-workspace-state/conversations` | Conversation export tooling (`server.ts:2764,2769`) |
| `OPENCODE_WORKSPACE_ENV_REPOS_ROOT` | `/home/dev/repos` | Workspace-env repos root (`server.ts:5115`) |
| `OPENCODE_FILE_VIEW_ROOTS`, `OPENCODE_BROWSER_OPTIMIZED_VIEWER_URL`, `OPENCODE_IOS_BRIDGE_INGEST_URL` / `OPENCODE_APPLE_BRIDGE_INGEST_URL` | n/a | See `tool/ios-bridge-events.ts:4` |
| `RECRAFT_API_KEY`, `GEMINI_API_KEY`, `OPENCODE_GEMINI_IMAGE_MODEL` | unset / `"imagen-3.0-generate-002"` | Image-gen provider credentials (`tool/image-gen.ts:35,52-53,73,112,133,136`) — distinct from the image-hub daemon proxy |
| `PARALLEL_API_KEY`, `OPENCODE_WEBSEARCH_PROVIDER`, `EXA_API_KEY` | unset | Web-search provider selection/credentials (`tool/websearch.ts:31,56-57`, `tool/mcp-websearch.ts:4-5`) |

---

## 4. Daemon lifecycle (the 3 standalone daemons)

### token-maxing (`token-maxing/`)

- **Start:** `npm install && npm run dev` (tsx watch, default config, subscription
  adapters OFF) or `npm start` for a plain run. With a config file:
  `cp config.example.json config.json` then `TM_CONFIG=./config.json npm start`
  (`token-maxing/README.md:47-67`).
- **Health/port:** binds `127.0.0.1:8787` only; `GET /health` returns liveness +
  per-adapter enabled state (`README.md:17-19,69-77`).
- **Gate:** `switch.enabled` in `config.json` is the master gate for account
  rotation (default `false`); `POST /switch` additionally requires a matching
  `operatorToken` on the `x-operator-token` header — two independent gates,
  both off by default (`README.md:82-93`). This is separate from, but mirrored
  by, the opencode-side `OPENCODE_TOKEN_MAXING_TOKEN` gate (§3.1/3.2) — the
  opencode server refuses to even attempt a switch call unless its own token
  env var is set (`server.ts:3178-3182`).
- **Graceful degradation:** confirmed — opencode's proxy catches fetch failures
  and returns `{ ok: false, error: "token-maxing daemon offline" }`
  (`server.ts:3160-3170`).

### Fleet service (`cross-cli-registry/`)

- **Start:** `pnpm install && pnpm dev:service` (runs `tsx bin/fleet-service.ts`)
  (`cross-cli-registry/README.md:19-23`).
- **Health/port:** binds `127.0.0.1:8788` (`FLEET_PORT` override); `GET /health`
  returns `{ ok, uptime, counts }` (`README.md:29,46`).
- **Gate:** `FLEET_DRIVE_ENABLED` (daemon's own env, unset by default) gates
  `POST /sessions/:cli/:id/continue` — returns `403` and spawns nothing when
  unset; setting it to `1` also flips the lower-level `CROSS_CLI_ALLOW_DRIVE`
  guard so the CLI actually launches (`README.md:31-40`). opencode's own proxy
  (`server.ts:1244-1262`) does not set or read this var — it only relays the
  daemon's 403 with a hint.
- **Graceful degradation:** confirmed — `server.ts:3219-3252` wraps the
  `/sessions` fetch in try/catch and returns `{ ok: false, fleet, error: "fleet
  service offline", sessions: [], count: 0 }` on failure or non-2xx.

### auto-improve daemon (`auto-improve/`)

- **Start:** `pnpm install && pnpm serve` (Node ≥20 with
  `--experimental-transform-types`) (`auto-improve/README.md:64-77`).
- **Health/port:** binds `127.0.0.1` only, port from `AUTO_IMPROVE_PORT`
  (default `8789`); `GET /health` → `{ status: "ok", uptimeSec }`
  (`README.md:91-99`).
- **Gate:** `AUTO_IMPROVE_ENABLED` (daemon's own env, unset/OFF by default) is
  the global gate; even when enabled, the default `StubExecutor` is a planned
  no-op — a real `CliExecutor` additionally requires
  `AUTO_IMPROVE_EXECUTOR=cli` + `AUTO_IMPROVE_CLI_ALLOW=1`, and the opener
  hard-refuses `main`/`master`/`HEAD` as a target branch regardless of gate
  state (`README.md:79-121`).
- **Graceful degradation:** confirmed — `server.ts:3252-3270` (same
  try/catch/offline pattern as the other two).

---

## 5. Security gates & defaults — prod checklist

| Gate | Env var | Required prod value | Risk if wrong |
|---|---|---|---|
| Routines scheduler execution | `OPENCODE_ROUTINES_RUN_ENABLED` | unset or anything other than `"1"` | If `"1"` **and** the mutations gate below also passes, the 30s scheduler tick will execute enabled routines' shell commands unattended |
| Routines mutations (the hidden co-gate) | `OPENCODE_ROUTINES_MUTATIONS` / `OPENCODE_HOSTNAME` | leave `OPENCODE_ROUTINES_MUTATIONS` unset, and do not set `OPENCODE_HOSTNAME=code.hustletogether.com` on any box where routine execution isn't intended | Setting `OPENCODE_HOSTNAME` to that exact string silently enables the mutations gate even if you never touch the mutations var directly (`routines.ts:897-898`) |
| Fleet drive (spawn a paid CLI) | `FLEET_DRIVE_ENABLED` (daemon-side, `cross-cli-registry`) | unset | If set, `POST /continue` will spawn a real, billable CLI session headlessly |
| Auto-improve live actions | `AUTO_IMPROVE_ENABLED` (daemon-side, `auto-improve`) | unset | If set (plus executor/allow flags), the daemon can open real PRs against designated projects |
| Token-maxing account switching | `OPENCODE_TOKEN_MAXING_TOKEN` | unset unless failover is explicitly wanted | Without it, `/switch` is hard-refused (403) at the opencode layer regardless of the daemon's own config — this is the correct prod posture unless failover is intended |
| Tracing content capture | `OPENCODE_TRACE_RECORD_CONTENT` | unset or anything other than `"1"` | If `"1"`, full prompt/response bodies (system+user messages, tool args, completions — may include pasted secrets/PII/proprietary code) ship to whatever OTLP endpoint is configured |
| Tracing enablement | `LANGSMITH_TRACING` + `LANGSMITH_API_KEY` | both unset unless tracing is explicitly wanted | Enables span emission (metadata only by default; see content-capture gate above for the higher-risk toggle) |
| Secrets mutation | `OPENCODE_SECRETS_ENABLED` | unset unless the secrets UI is needed | When on, `set`/`delete` secret endpoints are live; decrypted values are still never returned over HTTP by design (`store.ts:294-296`), only injected into spawned shell-tool child processes |
| Live-browser exposure | `OPENCODE_LIVE_BROWSER_EXPOSE` | `"0"` unless the feature is explicitly wanted | Default is **ON** (fails open) — confirmed at `server.ts:3838` |
| Live-browser access enforcement | `OPENCODE_LIVE_BROWSER_REQUIRE_ACCESS` | `"1"` on any publicly reachable box, together with the two Cloudflare Access vars below | Default is OFF — an exposed-but-unconfigured-Access live browser serves in `"live-public-warning"` mode rather than blocking (`server.ts:4066-4099`) |
| App-wide auth | `OPENCODE_SERVER_PASSWORD` | set on any box reachable beyond localhost | Unset ⇒ the entire HTTP API (session data, file browse, shell-adjacent tools, etc.) is unauthenticated except the small `isPublicUIPath` allowlist |

---

## 6. Public exposure

- **App-wide gate:** HTTP Basic Auth via `OPENCODE_SERVER_PASSWORD` /
  `OPENCODE_SERVER_USERNAME` (default username `"opencode"`). Enforced by
  `authorizationLayer` / `authorizationRouterMiddleware`
  (`packages/opencode/src/server/routes/instance/httpapi/middleware/authorization.ts:101-150`),
  which no-ops entirely if no password is configured
  (`ServerAuth.required`, `server/auth.ts:22-24`). Credentials may also be
  passed as an `auth_token` query param (base64 `user:pass`,
  `authorization.ts:12,77-79`) — treat that query param as sensitive in logs
  and proxies.
- **Cloudflare Access (live-browser feature only):** verified via `jose`'s
  `createRemoteJWKSet` + `jwtVerify` against
  `${OPENCODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, checking
  `audience` = `OPENCODE_CLOUDFLARE_ACCESS_AUD` and `issuer` = the team domain
  (`server.ts:4104-4112`); optionally further restricted to
  `OPENCODE_CLOUDFLARE_ACCESS_ALLOWED_EMAILS`. This does **not** cover the rest
  of the app — it is wired specifically into the `liveBrowserExposureAccess()`
  checks used by `/experimental/browser/*` and `/experimental/browser-use/*`
  routes (`server.ts:565-734` call sites). To actually require it (rather than
  fail open to a public warning banner), set
  `OPENCODE_LIVE_BROWSER_REQUIRE_ACCESS=1` in addition to the AUD/team-domain
  vars (§3.5, §5).
- **MCP gateway (docker mcp, port 8811):** the brief's seed asserts this should
  stay loopback / behind Access because it can spawn arbitrary containers.
  **This audit found no trace of it** — no `8811`, `"docker mcp"`, or
  `"mcp-gateway"` reference anywhere in this repo or in `token-maxing/`,
  `cross-cli-registry/`, or `auto-improve/`. If this component exists on the
  operator's box, it is not represented in any of the four repos audited here;
  secure it at the host/infra layer and do not assume any code in this repo
  gates it.
- **Recommended posture for any box reachable beyond `127.0.0.1`:** set
  `OPENCODE_SERVER_PASSWORD` (app-wide Basic Auth) at minimum; if the
  live-browser tab is enabled, also set `OPENCODE_LIVE_BROWSER_REQUIRE_ACCESS=1`
  plus both Cloudflare Access vars, and prefer fronting the whole app with a
  Cloudflare Access application (Access enforces at the edge/tunnel layer,
  independent of anything in this repo's code) rather than relying solely on
  the in-app JWT check.

---

## 7. Verification

- **Liveness:** `curl -fsS http://127.0.0.1:8299/global/health` → expect
  `{ "healthy": true, "version": "<...>" }`
  (`packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:83-85`,
  path registered at `groups/global.ts:66`).
- **Experimental/proxy endpoints** require the per-instance directory header
  (multi-project routing reads `x-opencode-directory` or a `?directory=`
  query param, falling back to `process.cwd()` —
  `middleware/workspace-routing.ts:87`):
  ```bash
  curl -H "x-opencode-directory: /path/to/a/project" \
    http://127.0.0.1:8299/experimental/token-maxing/usage

  curl -H "x-opencode-directory: /path/to/a/project" \
    http://127.0.0.1:8299/experimental/fleet/sessions

  curl -H "x-opencode-directory: /path/to/a/project" \
    http://127.0.0.1:8299/experimental/auto-improve/status

  curl -H "x-opencode-directory: /path/to/a/project" \
    http://127.0.0.1:8299/experimental/routines/status
  ```
  Each should return `ok: true` with real daemon data when the corresponding
  daemon is running, or `ok: false` with an `"... offline"` message when it
  isn't — never a 5xx/crash.
- **Daemon-side health checks** (direct, bypassing the opencode proxy):
  ```bash
  curl -fsS http://127.0.0.1:8787/health   # token-maxing
  curl -fsS http://127.0.0.1:8788/health   # fleet service
  curl -fsS http://127.0.0.1:8789/health   # auto-improve
  ```
- **Test suites:**
  ```bash
  cd packages/opencode && bun test test/server/
  ```
  Relevant daemon-proxy coverage lives in
  `test/server/httpapi-proxy-daemons.test.ts` and
  `test/server/httpapi-daemon-proxies.test.ts`; auth behavior in
  `test/server/auth.test.ts` and `test/server/httpapi-authorization.test.ts`.
  Per-daemon suites: `token-maxing/` → `npm test` (vitest); `cross-cli-registry/`
  → `pnpm test` (vitest — registry, drive, and service suites); `auto-improve/`
  → `pnpm test` (vitest, 40 tests covering config/scheduler/pr/safety/server).
