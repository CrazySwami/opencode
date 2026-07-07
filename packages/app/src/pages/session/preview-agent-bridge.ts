// Layer-1 agent bridge for the Preview iframe. Injected into the (same-origin)
// previewed app so the agent — or a human — can read the DOM and drive it with a
// visible "AI cursor" over real synthetic events. The bridge is pure theater over
// programmatic DOM events; it only works because Preview embeds content you own.
//
// Protocol (postMessage between parent and iframe):
//   parent -> iframe : { type: "opencode:ui-command", id, command: { action, ... } }
//   iframe -> parent : { type: "opencode:ui-result", id, result }
//   iframe -> parent : { type: "opencode:ui-bridge-ready", url }
//   iframe -> parent : { type: "opencode:ui-request-human", reason, snapshot }
//
// Actions: ui_read | ui_click(selector) | ui_type(selector,text) | ui_scroll(dx,dy) | ping

export const PREVIEW_UI_COMMAND = "opencode:ui-command"
export const PREVIEW_UI_RESULT = "opencode:ui-result"
export const PREVIEW_UI_READY = "opencode:ui-bridge-ready"
export const PREVIEW_UI_REQUEST_HUMAN = "opencode:ui-request-human"

export type UICommand =
  | { action: "ui_read" }
  | { action: "ui_click"; selector: string }
  | { action: "ui_type"; selector: string; text: string; submit?: boolean }
  | { action: "ui_scroll"; dx?: number; dy?: number }
  | { action: "request_human"; reason: string }
  | { action: "ping" }

export type UIElement = { i: number; tag: string; type?: string; testid?: string | null; text: string; selector: string }
export type UIResult =
  | { ok: true; url?: string; title?: string; elements?: UIElement[]; snapshot?: UIElement[] }
  | { ok: false; error: string }

// The bridge, serialized to a string and injected into the iframe document. Runs
// in the iframe's own context. Kept dependency-free and idempotent.
export const PREVIEW_AGENT_BRIDGE_SOURCE = `(() => {
  if (window.__opencodeAgentBridge) return;
  window.__opencodeAgentBridge = true;

  const cursor = document.createElement("div");
  cursor.setAttribute("data-opencode-agent-cursor", "");
  cursor.style.cssText = [
    "position:fixed","left:0","top:0","z-index:2147483647","width:22px","height:22px",
    "pointer-events:none","opacity:0","will-change:transform,opacity",
    "transition:transform .38s cubic-bezier(.22,1,.36,1),opacity .2s",
    "filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))"
  ].join(";");
  cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22" fill="none"><path d="M3 2l6.5 16 2.3-6.6L18 9 3 2z" fill="#f97316" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  const mount = () => { if (document.body && !cursor.isConnected) document.body.appendChild(cursor); };
  mount();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const moveCursor = async (x, y) => {
    mount();
    cursor.style.opacity = "1";
    cursor.style.transform = "translate(" + (x - 4) + "px," + (y - 2) + "px)";
    await sleep(400);
  };
  const ripple = (x, y) => {
    const d = document.createElement("div");
    d.style.cssText = [
      "position:fixed","z-index:2147483646","pointer-events:none","border-radius:9999px",
      "border:2px solid #f97316","left:" + (x - 6) + "px","top:" + (y - 6) + "px",
      "width:12px","height:12px","opacity:.9","transition:all .45s ease-out"
    ].join(";");
    document.body.appendChild(d);
    requestAnimationFrame(() => {
      d.style.width = "40px"; d.style.height = "40px";
      d.style.left = (x - 20) + "px"; d.style.top = (y - 20) + "px"; d.style.opacity = "0";
    });
    setTimeout(() => d.remove(), 500);
  };

  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return "";
    const tid = el.getAttribute && el.getAttribute("data-testid");
    if (tid) return '[data-testid="' + (window.CSS && CSS.escape ? CSS.escape(tid) : tid) + '"]';
    if (el.id) return "#" + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5 && node.tagName !== "BODY") {
      let seg = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (sibs.length > 1) seg += ":nth-of-type(" + (Array.prototype.indexOf.call(sibs, node) + 1) + ")";
      }
      parts.unshift(seg);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };

  const INTERACTIVE = "a,button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[data-testid],[contenteditable=true]";
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const snapshot = () => {
    const out = [];
    const els = document.querySelectorAll(INTERACTIVE);
    for (let k = 0; k < els.length && out.length < 80; k++) {
      const el = els[k];
      if (!visible(el)) continue;
      const text = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().replace(/\\s+/g, " ").slice(0, 70);
      out.push({
        i: out.length,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || undefined,
        testid: el.getAttribute("data-testid"),
        text,
        selector: cssPath(el),
      });
    }
    return out;
  };

  const resolve = (selector) => {
    if (!selector) return null;
    try { return document.querySelector(selector); } catch (e) { return null; }
  };
  const centerOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };

  const handle = async (cmd) => {
    try {
      if (!cmd || typeof cmd.action !== "string") return { ok: false, error: "bad command" };
      switch (cmd.action) {
        case "ping":
          return { ok: true, url: location.href, title: document.title };
        case "ui_read":
          return { ok: true, url: location.href, title: document.title, elements: snapshot() };
        case "ui_click": {
          const el = resolve(cmd.selector);
          if (!el) return { ok: false, error: "element not found: " + cmd.selector };
          el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          const c = centerOf(el);
          await moveCursor(c.x, c.y);
          ripple(c.x, c.y);
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: c.x, clientY: c.y }));
          el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: c.x, clientY: c.y }));
          if (typeof el.click === "function") el.click();
          await sleep(120);
          return { ok: true, snapshot: snapshot() };
        }
        case "ui_type": {
          const el = resolve(cmd.selector);
          if (!el) return { ok: false, error: "element not found: " + cmd.selector };
          const c = centerOf(el);
          await moveCursor(c.x, c.y);
          if (typeof el.focus === "function") el.focus();
          if ("value" in el) {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
            if (setter && setter.set) setter.set.call(el, String(cmd.text)); else el.value = String(cmd.text);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else if (el.getAttribute("contenteditable") === "true") {
            el.textContent = String(cmd.text);
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          if (cmd.submit) {
            el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
            const form = el.form; if (form && typeof form.requestSubmit === "function") form.requestSubmit();
          }
          await sleep(80);
          return { ok: true, snapshot: snapshot() };
        }
        case "ui_scroll": {
          window.scrollBy({ left: cmd.dx || 0, top: cmd.dy || 0, behavior: "smooth" });
          await sleep(200);
          return { ok: true, snapshot: snapshot() };
        }
        case "request_human": {
          window.parent.postMessage({ type: "opencode:ui-request-human", reason: String(cmd.reason || ""), snapshot: snapshot() }, "*");
          return { ok: true };
        }
        default:
          return { ok: false, error: "unknown action: " + cmd.action };
      }
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  };

  window.addEventListener("message", async (ev) => {
    const data = ev.data;
    if (!data || data.type !== "opencode:ui-command") return;
    const result = await handle(data.command);
    (ev.source || window.parent).postMessage({ type: "opencode:ui-result", id: data.id, result }, ev.origin && ev.origin !== "null" ? ev.origin : "*");
  });

  window.parent.postMessage({ type: "opencode:ui-bridge-ready", url: location.href, title: document.title }, "*");
})();`

export type PreviewAgentDriver = {
  ready: () => boolean
  send: (command: UICommand, timeoutMs?: number) => Promise<UIResult>
  dispose: () => void
}

// Parent-side driver: injects the bridge into a same-origin iframe on load and
// exposes a promise-based command channel. Also mirrors commands to a window API
// (window.__opencodePreviewUI) for console testing + future agent-tool wiring.
export function attachPreviewAgentBridge(
  iframe: HTMLIFrameElement,
  opts?: { onReady?: (url: string) => void; onRequestHuman?: (reason: string, snapshot: UIElement[]) => void },
): PreviewAgentDriver {
  let isReady = false
  let counter = 0
  const pending = new Map<number, (result: UIResult) => void>()

  const inject = () => {
    try {
      const doc = iframe.contentDocument
      const win = iframe.contentWindow
      if (!doc || !win) return // cross-origin (public) — bridge not available
      if ((win as unknown as { __opencodeAgentBridge?: boolean }).__opencodeAgentBridge) {
        isReady = true
        return
      }
      const script = doc.createElement("script")
      script.textContent = PREVIEW_AGENT_BRIDGE_SOURCE
      ;(doc.head || doc.documentElement || doc.body)?.appendChild(script)
    } catch {
      // cross-origin access denied — expected for non-same-origin previews.
    }
  }

  const onMessage = (ev: MessageEvent) => {
    if (ev.source !== iframe.contentWindow) return
    const data = ev.data as { type?: string; id?: number; result?: UIResult; url?: string; reason?: string; snapshot?: UIElement[] }
    if (!data || typeof data.type !== "string") return
    if (data.type === PREVIEW_UI_READY) {
      isReady = true
      opts?.onReady?.(data.url ?? "")
      return
    }
    if (data.type === PREVIEW_UI_RESULT && typeof data.id === "number") {
      pending.get(data.id)?.(data.result ?? { ok: false, error: "no result" })
      pending.delete(data.id)
      return
    }
    if (data.type === PREVIEW_UI_REQUEST_HUMAN) {
      opts?.onRequestHuman?.(data.reason ?? "", data.snapshot ?? [])
    }
  }

  const send = (command: UICommand, timeoutMs = 8000): Promise<UIResult> =>
    new Promise((resolve) => {
      const win = iframe.contentWindow
      if (!win) return resolve({ ok: false, error: "preview iframe not available" })
      const id = ++counter
      const timer = window.setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          resolve({ ok: false, error: "ui command timed out" })
        }
      }, timeoutMs)
      pending.set(id, (result) => {
        window.clearTimeout(timer)
        resolve(result)
      })
      win.postMessage({ type: PREVIEW_UI_COMMAND, id, command }, "*")
    })

  const onLoad = () => {
    isReady = false
    // Let the app boot a tick before injecting.
    window.setTimeout(inject, 60)
  }

  iframe.addEventListener("load", onLoad)
  window.addEventListener("message", onMessage)
  onLoad()

  // Console-testable + future agent-tool surface.
  ;(window as unknown as { __opencodePreviewUI?: unknown }).__opencodePreviewUI = {
    read: () => send({ action: "ui_read" }),
    click: (selector: string) => send({ action: "ui_click", selector }),
    type: (selector: string, text: string, submit?: boolean) => send({ action: "ui_type", selector, text, submit }),
    scroll: (dx?: number, dy?: number) => send({ action: "ui_scroll", dx, dy }),
    ping: () => send({ action: "ping" }),
    ready: () => isReady,
  }

  return {
    ready: () => isReady,
    send,
    dispose: () => {
      iframe.removeEventListener("load", onLoad)
      window.removeEventListener("message", onMessage)
      pending.clear()
    },
  }
}
