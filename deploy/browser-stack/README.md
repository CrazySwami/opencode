# OpenCode remote browser stack (neko + Steel + ttyd)

Replaces the old noVNC browser subsystem with a container stack on **CT100** that
OpenCode proxies to:

| Service | Role | Ports |
|---|---|---|
| **neko** | The *shared interactive browser* — WebRTC-streamed Chromium with a persistent profile. You watch and click; the agent drives the **same** browser over CDP. | `8080` (UI/ws), `52000-52100/udp` (media), `9223` (CDP) |
| **neko-cdp-proxy** | socat sidecar exposing neko's CDP (see gotcha #1). | — (shares neko's netns) |
| **Steel** | The *headless automation lane* — isolated/parallel agent sessions that must **not** disturb your live neko view. Has an embeddable viewer. | `3000` (API), `9224` (CDP), `5173` (viewer) |
| **ttyd** | Remote terminal into the stack host. | `7681` |

neko and Steel are **not redundant**: neko = one browser you and the agent share;
Steel = many disposable headless sessions for background/parallel automation.

## Bring-up (on CT100)

```bash
cp .env.example .env      # then edit: passwords, NEKO_NAT1TO1, TURN, ttyd creds
docker compose up -d
docker compose ps         # all services healthy?
```

Then set the `OPENCODE_*` vars (bottom of `.env.example`) on the **OpenCode server**
host and restart OpenCode. Leave `OPENCODE_BROWSER_STACK` unset until the smoke test
below passes — the flag is off by default and OpenCode keeps the old browser until you flip it.

## ⚠️ Verify before you trust it

The stack pins upstream images that move; two things must be checked against **your
pinned tags**, and two real gotchas are already handled but worth understanding.

1. **Regenerate `chromium.conf` from your pinned neko image.** The baseline launch
   command drifts between neko versions. Pull the original and re-apply only the two
   debug-flag deltas (documented at the top of `chromium.conf`):
   ```bash
   docker run --rm --entrypoint cat \
     ghcr.io/m1k1o/neko/chromium:<YOUR_TAG> /etc/neko/supervisord/chromium.conf
   ```
   Also confirm the in-image path — it has moved (`/etc/neko/supervisord/chromium.conf`
   vs `/etc/neko/chromium.conf`); fix the volume mount in `compose.yml` to match.

2. **Confirm Steel's env vars against the current repo.** Steel is beta and changes
   fast. Check `ghcr.io/steel-dev/steel-browser-api` env (`DOMAIN`, `CDP_DOMAIN`,
   `LOG_STORAGE_*`) against steel-browser's `docker-compose.yml` for your pinned tag.

3. **Gotcha — CDP is 127.0.0.1-only (handled).** Chromium M113+ force-binds
   `--remote-debugging-port` to `127.0.0.1` and ignores `--remote-debugging-address`.
   OpenCode therefore can't reach neko's CDP directly, so `neko-cdp-proxy` (socat)
   forwards `0.0.0.0:9223 → 127.0.0.1:9222` inside neko's network namespace.

4. **Gotcha — persistent profile is fragile (handled, verify).** neko's stock flags
   include `--bwsi` and `--disable-file-system`, which break logged-in profiles and
   downloads; `chromium.conf` drops both and mounts a `neko-profile` volume at
   `/home/neko/.config/chromium`. Persistence is still finicky upstream (issue #605) —
   verify a login survives `docker compose restart neko`.

## WebRTC reachability (the part that silently fails)

neko streams media **from CT100 to your browser** over WebRTC UDP. It works on a LAN
with just `NEKO_NAT1TO1` set to CT100's IP and the `52000-52100/udp` range open. If you
view OpenCode remotely (e.g. `code.hustletogether.com`), you almost certainly need a
**TURN server** — set `NEKO_ICESERVERS_FRONTEND`/`_BACKEND` to your TURN config, or the
viewer connects, shows black, and times out. STUN alone is not enough through symmetric NAT.

## Preview-proxy (showing "projects we run")

Local project/Next.js URLs (e.g. a dev server on CT100) are shown one of two ways:

- **Same-origin embed:** OpenCode's existing `/experimental/preview/proxy/<host><path>`
  route proxies a CT100-local URL so it embeds without CSP/X-Frame issues.
- **Drive neko to it:** the `browser` tool / address bar navigates neko directly to the
  project URL — full interaction, shares the persistent profile.

## Smoke test

```bash
# neko up + WebRTC signalling
curl -fsS http://CT100:8080/health && echo "neko ok"
# neko CDP reachable through the socat sidecar (should list a page target)
curl -fsS http://CT100:9223/json/version && echo "neko CDP ok"
# Steel API + its CDP + viewer
curl -fsS http://CT100:3000/health && echo "steel ok"
curl -fsS http://CT100:9224/json/version && echo "steel CDP ok"
curl -fsS -o /dev/null -w '%{http_code}\n' http://CT100:5173   # steel viewer -> 200
# ttyd
curl -fsS -o /dev/null -w '%{http_code}\n' http://CT100:7681   # -> 200 (or 401 if auth)
```

If `neko CDP ok` and `steel CDP ok` both print, OpenCode can drive both browsers.
Then set `OPENCODE_BROWSER_STACK=1` on the OpenCode host and open the Browser tab.
