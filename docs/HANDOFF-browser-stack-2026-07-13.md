# Handoff — neko/Steel/ttyd browser stack + daily-reports tab (+ Trellis bridge)

**Date:** 2026-07-13 · **Branch:** `deploy-merge` · **Repo:** github.com/CrazySwami/opencode

## Goal
Turn OpenCode into Alfonso's management front end. Two threads landed here:
1. **Replace the noVNC Browser/Preview tabs** with a **CT100-hosted neko + Steel + ttyd** stack — one shared interactive browser (neko, WebRTC + persistent profile, agent drives via CDP), a headless automation lane (Steel), and a remote terminal (ttyd).
2. **A personal daily-reports tab** (OpenBook) next to Routines.
(Plus the earlier read-only **Trellis** bridge, also in this branch.)

## Status: NOT complete. Here's the exact line.

### DONE + verified (32 tests green, `tsc` 0 across opencode/core/app, app builds)
- **Stack files** — `deploy/browser-stack/`: `compose.yml` (neko v3 + socat CDP sidecar + Steel API/UI + ttyd), `chromium.conf` (baseline + 2 CDP flags, drops `--bwsi`/`--disable-file-system`), `.env.example`, `README.md`. Authored from verified upstream (neko v3 env schema, Steel `ghcr.io/steel-dev/steel-browser-api`). **Image tags are `:latest` and MUST be pinned.**
- **Backend clients** — `packages/opencode/src/browser/{types,neko-client,steel-client}.ts`. Graceful-offline, never-throw, per-directory URL, token server-side only. neko-client handles the two CDP-behind-proxy gotchas: `Host: localhost` header + `rewriteCdpHost()` (Chromium reports `127.0.0.1:9222`). Tests: `test/browser/clients.test.ts` (11).
- **Status route** — `GET /experimental/browser/status` (neko+Steel+ttyd reachability, always-200 graceful). Test: `test/server/httpapi-browser-status.test.ts` (2).
- **Tools flag-branched** — `src/tool/browser.ts` → `runNekoBrowserAction` (open/goto/screenshot/eval/snapshot/show over CDP); `src/tool/browser-use.ts` → `runSteel` (status/sessions/create/close). Both gated on `OPENCODE_BROWSER_STACK`; **OFF path is byte-for-byte unchanged**.
- **neko frontend** — `session-side-panel.tsx` `BrowserTabContent`: a gated `<Show when={nekoMode()}>` absolute-inset WebRTC iframe (polls `/experimental/browser/status`). Default OFF → renders nothing → today's tab untouched.
- **Daily reports** — `src/reports/{types,fixtures,client}.ts` (built by a Fable subagent, verified) + `GET /experimental/reports/{list,health,get/:id}` + `panel://reports` capability (next to Routines) + `ReportsTabContent`. Fixtures-first. Tests: `test/reports/client.test.ts` (7) + `test/server/httpapi-reports.test.ts` (2).
- **Flag** — `experimentalBrowserStack: bool("OPENCODE_BROWSER_STACK")` in `src/effect/runtime-flags.ts`. Default OFF; NOT swept by `OPENCODE_EXPERIMENTAL`.

### NOT done (the remaining program)
- **ttyd terminal UI** — not wired into `terminal-panel.tsx` (345-line stateful component; use the same gated-overlay pattern as the neko viewer, poll `/experimental/browser/status` `.ttyd.url`).
- **Steel-viewer mode toggle** in the browser tab (surface `OPENCODE_STEEL_VIEWER_URL` as a second mode).
- **Agent-team orchestration surface** — the cross-CLI fleet tab already shows Claude/Codex; add an explicit Fable/Codex dispatch affordance. (Also: identify the "Theo bookmark" Claude/Codex/Fable repo — capability already works via subagents.)
- **Test matrix** — LLM-can-call-each-tool, routines notify+log, LangSmith/tracing. Browser cells need the live stack.
- **DELETE noVNC — LAST.** Only after neko proves on CT100. Remove: `httpapi/server.ts` routes ~570–808 (`novnc/*`, `optimized/*`, `live/*`) + helpers `liveBrowserNoVNC*`, `optimizedBrowserViewer*`, `liveBrowserStream`, `ensureLiveBrowser`, `captureLiveBrowserImage`, `runLiveBrowserInput`, `highlightLiveBrowserSelector`, `saveLiveBrowserScreenshot`, `liveBrowserExposureAccess/blocked`; the `browser_use` bridge (`:8768`); `PreviewTabContent` + `panel://preview` (leave an `aliasFor: panel://browser` shim); dead env `OPENCODE_LIVE_BROWSER_NOVNC_URL`, `OPENCODE_BROWSER_OPTIMIZED_VIEWER_URL`, `OPENCODE_BROWSER_NOVNC_*`.

## Locked decisions (do not re-litigate)
- CT100-hosted; OpenCode proxies via env URLs. Delete noVNC **fully but LAST** (flag-gate → prove → delete; never leave a broken browser).
- **neko vs Steel are NOT redundant:** neko = one shared interactive browser (human + agent, WebRTC + CDP, persistent profile); Steel = separate headless/isolated lane for background/parallel automation that must not hijack the neko view.
- ttyd = remote-stack terminal; native `bun-pty` stays for local.

## Gotchas already handled (keep them)
1. Chromium M113+ force-binds CDP to `127.0.0.1` → socat sidecar `0.0.0.0:9223→127.0.0.1:9222` (in `compose.yml`).
2. DevTools rejects non-localhost `Host` → neko-client sends `Host: localhost`.
3. Chromium reports `127.0.0.1` ws URLs → `rewriteCdpHost()`.
4. Persistent profile fragile (neko #605) + `--bwsi`/`--disable-file-system` break logins → `chromium.conf` drops them + volume mount.
5. WebRTC needs `NEKO_WEBRTC_NAT1TO1` + likely TURN for remote viewers.

## To bring it live (Alfonso / next session)
1. On CT100: `cd deploy/browser-stack && cp .env.example .env`, fill passwords + `NEKO_NAT1TO1` + TURN + **pin image tags**, `docker compose up -d`, run the README smoke test.
2. Regenerate `chromium.conf` from the pinned neko image (one-liner in the file header); fix the mount path if neko moved it.
3. On the OpenCode host: set `OPENCODE_NEKO_URL`, `OPENCODE_NEKO_CDP_URL`, `OPENCODE_STEEL_URL`, `OPENCODE_STEEL_VIEWER_URL`, `OPENCODE_TTYD_URL`, then `OPENCODE_BROWSER_STACK=1`. Open the Browser tab → neko overlay should appear.
4. Then: ttyd UI, Steel toggle, matrix, and finally delete noVNC.

## Verify
```
cd packages/opencode && bun test test/browser/ test/reports/ test/trellis/ \
  test/server/httpapi-browser-status.test.ts test/server/httpapi-reports.test.ts test/server/httpapi-trellis.test.ts
cd ../.. && for p in opencode core app; do bun run --cwd packages/$p typecheck; done
bun run --cwd packages/app build
```
