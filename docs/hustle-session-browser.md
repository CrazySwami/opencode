# Hustle Session Browser

Status: staged on CT100 from branch `feature/session-browser-playwright`. This does not change the live `code.hustletogether.com` service.

Staging URL:

```text
http://100.99.131.90:8310/
```

Staging command:

```bash
cd /home/dev/repos/opencode
bun run --cwd packages/opencode build --single --skip-install

OPENCODE_BROWSER_HOME=/home/dev/.local/share/opencode-browser-staging \
OPENCODE_PLAYWRIGHT_BROWSER=chrome \
packages/opencode/dist/opencode-linux-x64/bin/opencode web --port 8310 --hostname 0.0.0.0
```

## What This Adds

- A built-in OpenCode tool named `browser`.
- The tool runs `@playwright/cli` by default through `npx -y @playwright/cli`.
- The browser channel can be selected with `engine` on `browser.open` or `OPENCODE_PLAYWRIGHT_BROWSER`.
- Every OpenCode session gets a deterministic browser session id derived from the OpenCode session id.
- Browser state is isolated under `OPENCODE_BROWSER_HOME` or `~/.local/share/opencode-browser`.
- Screenshots are attached back to the chat as image tool-result attachments when Playwright CLI produces a PNG.
- Each browser session writes an `audit.jsonl` file with redacted command metadata.
- A right-side Browser tab polls `/experimental/browser/:sessionID/screenshot` and renders a real PNG frame from the same Playwright/Chromium session.
- A right-side Terminal tab reuses OpenCode's existing PTY context.
- A model-facing `terminal` tool aliases the existing shell implementation so users can explicitly ask the LLM to use terminal access.
- The composer `@` picker lists tool mentions. `@browser`, `@terminal`, built-in tools, and MCP/tool entries insert orange tool pills; browser and terminal use orange icons, MCP-style entries use an orange `MCP` badge when no branded icon is available. Submitted prompts include synthetic tool-tag context for the model.

## Session Model

OpenCode session `ses_123` maps to browser session `oc_ses_123`.

The default layout is:

```text
~/.local/share/opencode-browser/
  sessions/
    oc_ses_123/
      profile/
      artifacts/
      audit.jsonl
```

The browser is lazy. All sessions have the tool available, but Chromium does not start and no profile is created until the session calls:

```text
browser.open({ "url": "https://example.com" })
```

After that, the same OpenCode session can call `browser.snapshot`, `browser.click`, `browser.fill`, `browser.highlight`, `browser.screenshot`, `browser.resize`, `browser.requests`, `browser.console`, and related actions against the same isolated browser profile.

## Terminal Sessions

The OpenCode UI now has a right-side Terminal tab backed by the existing PTY system. The model tool list also exposes `terminal` as an alias over the existing shell implementation.

Terminal access can still use the same browser backing layer by calling Playwright CLI directly with the same session id:

```bash
npx -y @playwright/cli -s=oc_ses_123 snapshot
```

For tighter terminal/browser parity, expose `OPENCODE_BROWSER_HOME` and the session id in the terminal environment once the app UI owns the browser panel.

## Browser Preview Endpoint

The right-side Browser tab uses:

```text
GET /experimental/browser/:sessionID/screenshot
```

The route captures a fresh screenshot from Playwright CLI session `oc_<sessionID>` and returns `image/png`. It is screenshot polling, not full remote-desktop streaming.

## Verified On CT100

- Bun `1.3.14` is installed.
- Branch dependencies are installed in `/home/dev/repos/opencode/node_modules`.
- `bun run --cwd packages/opencode typecheck` passes.
- Google Chrome `149.0.7827.200` is installed.
- `@playwright/cli` opens, snapshots, screenshots, and closes a named session.
- Staged OpenCode on port `8310` exposes `browser` and `terminal` from `/experimental/tool/ids`.
- `/experimental/browser/ses_0eefea99effe84iHh3oi4IzrpX/screenshot` returned a `1280 x 720` PNG from the Yahoo Chromium session.
- The staged UI showed `Live Chromium viewport`, status `refreshing`, and `img "Live Chromium browser viewport"`.
- Direct branch-runtime smoke produced:
  - `browserSessionID`: `oc_ses_direct_browser_smoke`
  - screenshot: `/home/dev/.local/share/opencode-browser-staging/sessions/oc_ses_direct_browser_smoke/artifacts/.playwright-cli/page-2026-06-29T00-54-10-177Z.png`
  - audit: `/home/dev/.local/share/opencode-browser-staging/sessions/oc_ses_direct_browser_smoke/audit.jsonl`

The staged UI session successfully opened Yahoo through the `browser` tool and the Browser tab rendered the real Chromium screenshot preview.

## Deployment Notes

Chrome is now installed on CT100. A staged or live service should still set the browser env explicitly:

```bash
OPENCODE_BROWSER_HOME=/home/dev/.local/share/opencode-browser
OPENCODE_PLAYWRIGHT_BROWSER=chrome
```

Use `OPENCODE_PLAYWRIGHT_CLI` if we want a pinned local wrapper instead of `npx -y @playwright/cli`.

## Slash And At Commands

Original upstream OpenCode behavior:

- `@` references files and attachments into the prompt.
- `/` opens slash commands, custom commands, MCP prompts, and skills.
- The existing UI does not provide a default way to tag arbitrary tools the same way files are tagged.

Our custom build now adds tool mentions in the app layer:

- `@browser` tags the per-session Chromium browser tool.
- `@terminal` tags the terminal/shell alias tool.
- MCP/tool entries are available from the same `@` picker.
- Tool tags are prompt pills in the editor and are converted into model-visible synthetic context on submit.

Next app-layer patch candidates:

- `/browser` inserts a browser task prompt or opens the browser tab.
- `/screenshot` calls or prompts the `browser.screenshot` flow.
- `/highlight` asks the model to run `browser.highlight` on the current element ref.
- Browser artifacts can become mentionable items after the browser panel stores them in session state.

## Browser Tab Direction

The maintainable path is:

1. Keep `browser` as the stable backend contract.
2. Keep the right-side Browser and Terminal tabs.
3. Keep `/experimental/browser/:sessionID/screenshot` as the first browser viewport bridge.
4. Add controls for snapshot, screenshot, highlight, network, console, and tab selection.
5. Add full mouse/keyboard streaming or click-to-annotate overlays if screenshot polling is not enough.

This is not a wrapper around OpenCode. It is a small fork patch that adds a browser capability to OpenCode's own tool registry and then can add native tab UI against that capability.
