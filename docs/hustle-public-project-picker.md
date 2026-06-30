# OpenCode Public Project Picker Runbook

Last verified: 2026-06-29

## Purpose

This documents the `code.hustletogether.com` fix that makes every browser land on the same server-backed OpenCode workspace and makes the **Open Project** modal show real folders from `/home/dev/repos`.

Keep this runbook in Alfonso OS and in the server OpenCode repo because the live behavior depends on a server-side proxy wrapper, not only the upstream OpenCode source.

## Live Shape

- Public URL: `https://code.hustletogether.com`
- Live-only policy: use `https://code.hustletogether.com` only
- Legacy alias: `https://opencode.hustletogether.com` was removed from the active CT100 and Proxmox Cloudflare tunnel configs on 2026-06-29; if it still returns a Cloudflare Access response, that is a Cloudflare/DNS object outside the active OpenCode tunnel config, not a live OpenCode runtime.
- Cloudflare route origin: Proxmox loopback `127.0.0.1:18300`
- CT100 proxy service: `opencode-public-proxy.service`
- CT100 proxy listener: `0.0.0.0:8300`
- CT100 OpenCode service: `opencode.service`
- CT100 OpenCode internal origin: `127.0.0.1:8299`
- OpenCode service user: `dev`
- Default server workspace root: `/home/dev/repos`
- Server state/database path: `/home/dev/.local/share/opencode/`
- Main database: `/home/dev/.local/share/opencode/opencode.db`
- Proxy script: `/usr/local/sbin/opencode-public-proxy.mjs`
- Dev-root normalizer: `/usr/local/sbin/opencode-normalize-dev-root.py`
- First-visit browser bootstrap: `https://code.hustletogether.com/` sets the `opencode_devroot_reset` cookie with a `302` redirect when missing.
- Manual browser reset: `https://code.hustletogether.com/__reset`
- Proxy health: `https://code.hustletogether.com/__health`

There is intentionally no separate OpenCode staging/dev listener right now. The earlier direct `0.0.0.0:8310` runtime was stopped, and stale staging/smoke browser profile directories were removed so agents and humans converge on the same live instance.

## What Was Broken

Different browsers showed different OpenCode project lists because there were two separate problems:

1. Browser-local OpenCode state could keep a stale project or root directory such as `root`, `/`, or `/home/dev`.
2. The **Open Project** modal was not using only `/project/{id}/directories`. It also called:

```text
/find/file?directory=/home/dev&query=&type=directory&limit=50
```

OpenCode returned an empty array for that route when the base directory was `/home/dev`, so the modal showed **No folders found** even though `/home/dev/repos` contained the actual projects.

## What We Changed

The public proxy now protects the server-backed default workspace in six places.

1. **Project/session normalization**

   Stale browser requests for `root`, `/`, or bad root-like directories are normalized to `/home/dev/repos` before reaching the client.

2. **Project directory listing**

   `/project/{id}/directories` returns real child folders from `/home/dev/repos` when the request represents the default workspace.

3. **Open Project modal search**

   The modal route below is patched:

   ```text
   /find/file?directory=/home/dev&query=&type=directory&limit=50
   ```

   It returns relative entries shaped like:

   ```text
   repos/brand-studio/
   repos/alfonso-os/
   repos/Hustle-Together/
   ```

   This shape is intentional. The modal joins those paths against `/home/dev`, which creates the correct absolute folders under `/home/dev/repos`.

4. **Browser reset/bootstrap**

   First uncookied visits to `/` get a same-origin bootstrap redirect that sets the reset-version cookie without clearing browser storage. `/__reset` can be opened manually when one browser or device still has stale local OpenCode state.

   The reset page clears:

   - localStorage
   - sessionStorage
   - Cache Storage
   - IndexedDB
   - registered service workers

   Manual `/__reset` sends `Clear-Site-Data: "cache", "storage"` and writes the current reset-version cookie so a browser can deliberately converge on the same Dev Folder state. The normal first-visit path must not clear storage because that wipes workspace tab state, Preview/File Browser state, and composer follow-up queues.

5. **Session active-project normalization**

   `/session` and `/session/{id}` responses are normalized so a session under a known repo path is reported with that repo project's ID.

   Example:

   ```text
   /home/dev/repos/brand-studio -> Brand Studio Runtime project
   /home/dev/repos -> Dev Folder project
   ```

   This keeps the active project highlight consistent across Codex browser, Chrome, and iPad when they open the same session.

6. **Merged project-session listing**

   OpenCode can return a project session through `/session/{id}` and `/session?directory=<repo>` while omitting it from the plain `/session` list. The upstream server also did not reliably honor `/session?projectID=<id>`.

   The proxy now:

   - maps `/session?projectID=<id>` to the matching project worktree;
   - fetches `/session?directory=<worktree>` for that project;
   - merges plain `/session` with one directory-specific session list for every known project;
   - deduplicates by session ID and sorts by newest update time.

   Example verified case:

   ```text
   alfonso-os / Repo visibility check
   session id: ses_0f04fd38affeygMhEY4xlSxRMO
   directory: /home/dev/repos/alfonso-os
   ```

   This session existed in the database and direct session route, but was missing from the generic sidebar list until the merged-list proxy behavior was added.

## Verification Commands

Run from the Mac:

```bash
ssh -o BatchMode=yes hustle-dev 'systemctl is-active opencode-public-proxy opencode && opencode --version'
curl -sS 'https://code.hustletogether.com/__health'
curl -sS 'https://code.hustletogether.com/find/file?directory=%2Fhome%2Fdev&query=brand&type=directory&limit=20'
curl -sS 'https://code.hustletogether.com/project'
curl -sS 'https://code.hustletogether.com/session' | head -c 1200
```

Expected important results:

- both services are `active`
- OpenCode binary reports the current installed version
- `__health` returns `ok: true`
- the `find/file` check returns entries such as `repos/brand-studio/`
- the project list includes the default Dev Folder rooted at `/home/dev/repos`
- brand-studio sessions report the Brand Studio Runtime project ID while `/home/dev/repos` sessions report `global`
- plain `/session` includes project-directory sessions such as `Repo visibility check`
- `/session?projectID=<alfonso-os id>` returns the same session list as `/session?directory=/home/dev/repos/alfonso-os`

## Browser Recovery

If Chrome, Codex browser, or iPad show different projects:

1. Open `https://code.hustletogether.com/__reset` in that same browser.
2. Click **Reset and open OpenCode** if the page does not auto-run.
3. Reload `https://code.hustletogether.com/`.
3. Open **Open Project** again.

The modal should list folders from `/home/dev/repos`.

## Session Persistence

Sessions are server-side for the `code.hustletogether.com` OpenCode service because all clients hit the same `opencode.service` and the same `/home/dev/.local/share/opencode/` database as user `dev`.

What persists:

- OpenCode sessions saved in the server database.
- Project/session history for the same server-backed OpenCode instance.
- Tool output and snapshots under `/home/dev/.local/share/opencode/`.

What can still vary by browser:

- Browser-local UI state before `/__reset`.
- Which project/folder a browser last selected.
- Any stale client storage from older OpenCode versions or older proxy behavior.

That means session data is persistent on the server, but a browser may need `/__reset` once if its local state points at an outdated folder.

## Safe Edit Points

Do not patch upstream OpenCode for this unless promoting a proper fork. The live production behavior currently lives here:

```text
/usr/local/sbin/opencode-public-proxy.mjs
/usr/local/sbin/opencode-normalize-dev-root.py
/etc/systemd/system/opencode-public-proxy.service
/etc/systemd/system/opencode.service
```

After edits:

```bash
node --check /usr/local/sbin/opencode-public-proxy.mjs
systemctl restart opencode-public-proxy
systemctl is-active opencode-public-proxy
```

Do not restart `cloudflared` or change Cloudflare routes unless the route itself is broken. This picker fix is CT100 proxy behavior.
