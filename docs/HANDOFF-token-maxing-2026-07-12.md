# Handoff — Token Maxing + OpenCode Dashboard (2026-07-12)

## Repos (pushed)
| Repo | URL | Branch | Notes |
|---|---|---|---|
| **token-maxing** | `github.com/CrazySwami/token-maxing` (**private**) | `main` | Committed history only. ⚠️ the other agent's latest **uncommitted** WIP (LangSmith/observability, client-smoke) is NOT in this push — it lands when that agent commits. |
| **opencode** | `github.com/CrazySwami/opencode` | `deploy-merge` | Dashboard + tracing + tests. Open a PR to merge → `main` (I did NOT force-push over `main`). |

## The two systems
- **token-maxing** — a **localhost-only, read-only-first control plane** (`127.0.0.1:8787`). Reads *real* multi-account LLM usage and exposes `/v1/status` with 4 first-class contracts: **AccountLane / InferenceEndpoint / ModelRoute / ClientAdapter**. Account *switching* is built but **gated OFF** (M1 is read-only; mutation returns later behind preview→apply→verify→rollback).
- **opencode** — the dashboard. Has a **Token Maxing tab** + **LangSmith tracing** (now actually exports).

## What's DONE
**token-maxing** (390+ tests, tsc clean):
- Read-only M1: status envelope, endpoint catalog (AI Hub/Ollama/generic), client registry, real usage adapters (GLM, Claude, Codex multi-account via local logs, OpenAI verify-only, Grok/Gemini).
- **Provider-adapter-SDK** (`src/providers/`) — add an LLM with **no core edit** (see `docs/adding-a-provider.md`). Unconnected providers register dormant (`no_key`) until keyed.
- Bug-fixes: openai verify-only, Codex `session_meta` attribution, null-limit fail-closed, transactional account switch, `/switch` 400.
- Eval-harness (gold standard + scorers).

**opencode:**
- **Tracing exports end-to-end** — `resolveExporter()` auto-derives the LangSmith OTLP exporter from `LANGSMITH_TRACING`+`LANGSMITH_API_KEY` (was silently exporting nothing). Proven at unit + span-to-mock-collector + HTTP-status levels. `/experimental/tracing/status` reports `exporterConfigured`.
- First SolidJS **render harness** + a real Token Maxing tab render test.
- Fixed a real **`createPolledJson` hot-loop** bug (affected every polled tab).

## DEFERRED BY DESIGN (not gaps)
- `manual-account-switch` + `policy-gated-failover` — the mutation/auto-rotation milestones. Intentionally not built in read-only M1; they return in a later, approval-gated milestone.

## IN-FLIGHT (other agent, token-maxing, uncommitted at push time)
- LangSmith observability eval lane, client-model-compatibility, cross-platform packaging.

## Blockers (need Alfonso)
- `LANGSMITH_API_KEY` → Tier-A real trace (Tier-B mock proof already landed).
- `XAI_API_KEY` + `GEMINI_API_KEY` → live-verify Grok/Gemini adapters.
- Additional Codex accounts on this Mac (`CODEX_HOME=~/.codex-accounts/<id> codex login`) → live multi-account rotation.
- "Deploy go" for the CT100 box rebuild.

## How to run
**token-maxing:**
```
cd ~/Documents/GitHub/token-maxing
npm install && npm start          # daemon → http://127.0.0.1:8787
npm run status                    # CLI status view
# cp config.example.json config.json ; edit adapters/endpoints/switch
```
Reads creds from: env (`XAI_API_KEY`, `GEMINI_API_KEY`, `LANGSMITH_*`),
`~/.local/share/opencode/auth.json`, macOS Keychain (Claude), `~/.codex` (Codex).

**opencode:** standard monorepo build; the box uses `oc-rebuild.sh`/`oc-deploy.sh`.

## Adding a new / not-yet-connected LLM
1. Write an adapter under `token-maxing/src/adapters/` (copy `grok.ts` for API-key, `glm.ts` for quota %, `claude-sub.ts` for rate-limit headers, `codex-account.ts` for multi-account local logs).
2. `defineProvider({ manifest, createAdapters })` in `src/providers/index.ts`.
3. Add a fixture test. Done — `buildAllAdapters()` assembles from the registry. Full guide: `token-maxing/docs/adding-a-provider.md`.

## ⚠️ Coordination + org notes
- **Two agents shared `token-maxing`**; I own `opencode`. The one overlap file was `token-maxing/src/server.ts` (both edited; coherent — my provider imports were absorbed by the other agent). **Recommend one owner per repo** going forward to avoid clobbering.
- token-maxing is **Mirror-Factory-labeled** but pushed **private under personal `CrazySwami`** as a backup. Transfer to a Mirror Factory org if you want the account boundary clean (per your standing rule that MF ≠ personal OpenCode).
