# CT100 OpenCode — Session Handoff (2026-07-09)

> A fresh session **auto-loads memory** (`~/.claude/.../memory/MEMORY.md` → `project_ct100_opencode_stability.md`)
> which has the full detail. This file is the scannable next-steps summary. Local work is committed on
> branch `local-dev-20260707-215203` (commit `c3b41d7`).

## ✅ Live on code.hustletogether.com (deployed + verified, release `...odroutines-20260709010300`)
- 502 / "Failed to load sessions" resilience (retry budget + soft-fail)
- OD/Claude bridge rendering → then **bridge REMOVED** (mirror gone, OpenDesign **tab kept**)
- **Memory floor** 2.5 GB → 235 MB (bounded per-directory instance cache, `instance-state.ts`, cap 64 env-tunable)
- **Memory spikes** tamed (SSE reconnect backoff+jitter, `server-sdk.tsx`)
- **Tab lag** → keep-alive OpenDesign+Preview iframe tabs
- **Model-flip fix** (Codex multi-auth now honors selected `--model`)
- Routines **runner** built + tested — **DEPLOYED GATED OFF** (safe, cannot execute)

## 🔒 Critical safety note
**Do NOT set `OPENCODE_ROUTINES_RUN_ENABLED=1`** on the live box. Codex reviewed the routines runner →
**CRITICAL**: the `routines` tool is model-callable, so enabling execution lets an agent run arbitrary
shell commands bypassing the Bash approval gate. Live box verified SAFE (flag off → `manual_runs_disabled`).

## 📋 Remaining work (priority order)
1. ✅ **Routines security hardening — DONE + Codex-signed-off + DEPLOYED (2026-07-09, run flag still OFF).**
   Release `...routineshardened-20260709023140` LIVE on code.hustletogether.com (public health 200, `runEnabled:false`
   verified, live run refused, opencode RSS 561MB post-restart). Local work still UNCOMMITTED on branch
   local-dev-20260707-215203 (4 files). Box synced by checksum-verified copy (box working-tree matched my base
   for all 4 files). **DID NOT set `OPENCODE_ROUTINES_RUN_ENABLED=1` — execution stays gated (plan A).**
   All 8 must-fixes implemented in `packages/opencode/src/tool/routines.ts` (+483) and `server.ts` (+61):
   per-routine ctx.ask approval gate (permission `routines`) + single-use approval nonce **bound to
   command/host/updatedAt** (TOCTOU-safe); require `enabled===true` + operator token (`OPENCODE_ROUTINES_OPERATOR_TOKEN`);
   fail-closed invalid host; **in-process `RUNNING` Set lock** (atomic; lockfile advisory-only) + crash
   reconcile via `!RUNNING.has`; kill process-group + remote base64|setsid `timeout` wrapper; log rotation
   (512KB, .1 backup) + bounded tail reads; redact secrets + minimal allowlisted spawn env; HTTP body-size
   413 (Content-Length pre-check + Buffer.byteLength) + run rate-limit 429. Codex 3 rounds: 4 findings →
   #1 High TOCTOU FIXED, #3 Med lock-race FIXED (Set rewrite), #2/#4 accepted low-sev residuals
   (#2 chunked-body buffering DoS; #4 setsid-escape not a true tree-kill — both approval-gated).
   **Accepted architectural constraint (Codex): single opencode process per routines-storage path** (the box's
   reality; documented in code comment, not code-enforced). Locally functional-tested: disabled/no-approval/
   invalid-host/concurrent-lock/crash-reconcile all correct; secret stripped from spawn env. Both pkgs typecheck 0.
   **NEXT: deploy (checksum-verified copy, box repo diverged) → THEN optionally `OPENCODE_ROUTINES_RUN_ENABLED=1`.
   Live box still has run flag OFF. Enabling execution on prod = get explicit user go-ahead first.**
2. ✅ **Routines UI — DONE (uncommitted, typecheck-clean, NOT browser-verified).** Host dropdown (from
   `status.hosts`) + icon input in BOTH `session-side-panel.tsx RoutinesTabContent` and
   `home.tsx HomeRoutinesDashboard` create/edit forms; icon+host shown in list rows + detail headers.
   Server POST/PATCH now pass `host`/`icon` through. Still needs a visual browser pass.
3. **Routines scheduler** (auto-run on schedule; run-now path works + hardened now).
4. **OD MCP proxy** (#48): front one `od mcp` (stdio) with a stdio→HTTP/SSE proxy, add to
   `/home/dev/.config/opencode/opencode.jsonc` `mcp` as `type:remote` (single shared connection — NOT
   `type:local`, which spawns a process per project instance and re-bloats memory). Read tools need no token.

## 🛠️ Deploy mechanics (proven this session)
- Box build repo: `hustle-dev:/home/dev/repos/opencode` (branch `feature/session-browser-playwright`), bun 1.3.14.
- Box **diverged** from local — sync changed files by **checksum-verified copy** (`cat local | ssh 'cat > box/path'`), NOT git patches.
- Build: `ssh hustle-dev` → edit `/home/dev/shared/oc-rebuild.sh` label → `setsid bash oc-rebuild.sh` → poll `/tmp/oc-build.log` for `BUILD_DONE`.
- Deploy: `setsid sudo bash /home/dev/shared/oc-deploy.sh` → poll `/tmp/oc-deploy.log` for `DEPLOY_DONE` → clean `dist`.
- CT100 ssh alias = `hustle-dev`. Restarts cause reconnect storms (backoff now mitigates). Watchdog recycles opencode at RSS>3300MB idle.
- Local dev: `~/Documents/GitHub/opencode` → `./dev-local.sh` (UI on :3000 → CT100 main). Typecheck: `bun --cwd packages/<pkg> run typecheck`.

## 🤝 Codex (review partner)
`/codex:rescue` (or Agent subagent_type `codex:codex-rescue`) — caught 5 real bugs this session. Use it to review each new change (esp. the routines hardening) before deploy.
