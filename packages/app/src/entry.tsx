// @refresh reload

import * as Sentry from "@sentry/solid"
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { type Platform, PlatformProvider } from "@/context/platform"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { handleNotificationClick } from "@/utils/notification-click"
import { authFromToken } from "@/utils/server"
import pkg from "../package.json"
import { ServerConnection } from "./context/server"

const DEFAULT_SERVER_URL_KEY = "opencode.settings.dat:defaultServerUrl"
const CT100_SERVER_URL = "https://code.hustletogether.com"
const CT100_TAILSCALE_URL = "http://100.99.131.90:8310"
const MAC_SERVER_URL = "https://alfonsos-macbook-pro.tailf704e2.ts.net:4096"

const CT100_PROJECT_SEEDS = [
  "/home/dev/repos/AI-Brand-Studio",
  "/home/dev/repos/AI-Brand-Studio-main-brand-studio-package",
  "/home/dev/repos/Blog-Approval-Application",
  "/home/dev/repos/Eleven-Labs-Wordpress-Plugin",
  "/home/dev/repos/GPTCache",
  "/home/dev/repos/Hustle-Dash",
  "/home/dev/repos/Hustle-Together",
  "/home/dev/repos/Hustle-Tweets",
  "/home/dev/repos/JS-Front-End",
  "/home/dev/repos/LLM-APIs",
  "/home/dev/repos/LLM-Experiments",
  "/home/dev/repos/MF-Workstation",
  "/home/dev/repos/MM-REACT",
  "/home/dev/repos/Mercury-Editor-demo",
  "/home/dev/repos/Moonshots-Magic-AI-Map",
  "/home/dev/repos/OpenChat",
  "/home/dev/repos/ROI-Official-Company-Repo",
  "/home/dev/repos/ROI-amplified-website",
  "/home/dev/repos/SquareCoil",
  "/home/dev/repos/TKX-Email-Generator",
  "/home/dev/repos/TKX-Ticket-Data-Analysis",
  "/home/dev/repos/alfonso-os",
  "/home/dev/repos/api-dev-tools",
  "/home/dev/repos/api_test",
  "/home/dev/repos/audio-layer",
  "/home/dev/repos/aura",
  "/home/dev/repos/brand-studio",
  "/home/dev/repos/chatbot-az",
  "/home/dev/repos/chatbot-ui",
  "/home/dev/repos/crochet-tool",
  "/home/dev/repos/csr-theme",
  "/home/dev/repos/developer-docs-temp",
  "/home/dev/repos/devtest2026",
  "/home/dev/repos/ditto",
  "/home/dev/repos/docs",
  "/home/dev/repos/easel",
  "/home/dev/repos/faq-wp-plugin",
  "/home/dev/repos/gpt-researcher",
  "/home/dev/repos/hustle-ai",
  "/home/dev/repos/hustle-api",
  "/home/dev/repos/hustle-dashboard-dev",
  "/home/dev/repos/hustle-dashboard-next",
  "/home/dev/repos/hustle-dashboard-production",
  "/home/dev/repos/hustle-dashboard-staging",
  "/home/dev/repos/hustle-dev-app",
  "/home/dev/repos/hustle-elementor",
  "/home/dev/repos/hustle-elementor-webapp",
  "/home/dev/repos/hustle-for-life",
  "/home/dev/repos/hustle-hub",
  "/home/dev/repos/hustle-tersa",
  "/home/dev/repos/hustle-together-Archived-",
  "/home/dev/repos/hustle-together-ai",
  "/home/dev/repos/hustle-together-api",
  "/home/dev/repos/hustle-together-dashboard",
  "/home/dev/repos/hustle-together-dashboard-release-20260603-040204",
  "/home/dev/repos/hustle-together-dashboard-source",
  "/home/dev/repos/hustle-together-local-api",
  "/home/dev/repos/hustle-together-sites",
  "/home/dev/repos/hustle-together-wordpress-plugin",
  "/home/dev/repos/hustle-tools",
  "/home/dev/repos/layers",
  "/home/dev/repos/layers-dev",
  "/home/dev/repos/layers-mf",
  "/home/dev/repos/lcpmd",
  "/home/dev/repos/local-ai-chat",
  "/home/dev/repos/mf-core",
  "/home/dev/repos/mf-symphony",
  "/home/dev/repos/mirror-factory",
  "/home/dev/repos/mirror-factory-website",
  "/home/dev/repos/muse",
  "/home/dev/repos/nextjs-fastapi-starter",
  "/home/dev/repos/nextjs-fastapi-starter-testing",
  "/home/dev/repos/nextjs-fastapi-startertest",
  "/home/dev/repos/nextjs-openai-doc-search-starter",
  "/home/dev/repos/nextjs-with-supabase",
  "/home/dev/repos/olive-branch-plugin-dev",
  "/home/dev/repos/open-design",
  "/home/dev/repos/open-design-runtime",
  "/home/dev/repos/open-swiftui-animations",
  "/home/dev/repos/opencode",
  "/home/dev/repos/opencode-github-push",
  "/home/dev/repos/openv0",
  "/home/dev/repos/orlando-daily",
  "/home/dev/repos/platforms-starter-kit",
  "/home/dev/repos/python-hello-world",
  "/home/dev/repos/quivr",
  "/home/dev/repos/ralph-claude-plugin",
  "/home/dev/repos/rapidpages",
  "/home/dev/repos/roi-amplified",
  "/home/dev/repos/roi-website-pages",
  "/home/dev/repos/sazant-wp-site",
  "/home/dev/repos/search_with_lepton",
  "/home/dev/repos/sway-surface",
  "/home/dev/repos/vercel-ai-starter-kit",
  "/home/dev/repos/x-bookmark-review",
]

const MAC_PROJECT_SEEDS = [
  "/Users/alfonso/Documents/GitHub/AI-Brand-Studio",
  "/Users/alfonso/Documents/GitHub/Hustle-Together",
  "/Users/alfonso/Documents/GitHub/LLM-Experiments",
  "/Users/alfonso/Documents/GitHub/Mercury-Editor-demo",
  "/Users/alfonso/Documents/GitHub/Moonshots-Magic-AI-Map",
  "/Users/alfonso/Documents/GitHub/ROI-Clients",
  "/Users/alfonso/Documents/GitHub/ROI-Official-Company-Repo",
  "/Users/alfonso/Documents/GitHub/SquareCoil",
  "/Users/alfonso/Documents/GitHub/alfonso-os",
  "/Users/alfonso/Documents/GitHub/api-dev-tools",
  "/Users/alfonso/Documents/GitHub/audio-layer",
  "/Users/alfonso/Documents/GitHub/hustle-together-dashboard",
  "/Users/alfonso/Documents/GitHub/layers",
  "/Users/alfonso/Documents/GitHub/local-ai-chat",
  "/Users/alfonso/Documents/GitHub/open-design",
  "/Users/alfonso/Documents/GitHub/sazant-wp-site",
  "/Users/alfonso/Documents/GitHub/x-bookmark-review",
]

const normalizedUrl = (url: string) => url.replace(/\/+$/, "")
const isCT100Url = (url: string) => {
  const value = normalizedUrl(url)
  return value === CT100_SERVER_URL || value === CT100_TAILSCALE_URL
}
const isMacUrl = (url: string) => normalizedUrl(url) === MAC_SERVER_URL

const builtInServers = (current: ServerConnection.Http) => {
  const defaults: Array<ServerConnection.Http> = [
    {
      type: "http",
      displayName: "code.hustletogether.com",
      label: "LIVE",
      http: { url: CT100_SERVER_URL },
    },
  ]
  // The Mac server is a private tailnet address. Only seed it for clients that
  // opt in (localStorage flag / ?seedMac=1) or are already connected to it, so
  // other clients and headless loads never fire blocked/hanging fetches to it.
  if (shouldSeedMac(current)) {
    defaults.push({
      type: "http",
      displayName: "Alfonso Mac",
      label: "MAC",
      http: { url: MAC_SERVER_URL, username: "opencode" },
    })
  }

  const servers = new Map<ServerConnection.Key, ServerConnection.Http>()
  for (const conn of defaults) servers.set(ServerConnection.key(conn), conn)

  const key = ServerConnection.key(current)
  const existing = servers.get(key)
  servers.set(key, {
    ...existing,
    ...current,
    displayName: current.displayName ?? existing?.displayName,
    label: current.label ?? existing?.label,
    http: { ...(existing?.http ?? {}), ...current.http },
  })

  return [...servers.values()]
}

const projectSeeds = (current: ServerConnection.Http) => {
  const seeds: Record<string, string[]> = {
    [CT100_SERVER_URL]: CT100_PROJECT_SEEDS,
    [CT100_TAILSCALE_URL]: CT100_PROJECT_SEEDS,
    [MAC_SERVER_URL]: MAC_PROJECT_SEEDS,
  }

  if (isCT100Url(current.http.url)) seeds.local = CT100_PROJECT_SEEDS
  if (isMacUrl(current.http.url)) seeds.local = MAC_PROJECT_SEEDS

  return seeds
}

const getLocale = () => {
  if (typeof navigator !== "object") return "en" as const
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("zh")) return "zh" as const
  }
  return "en" as const
}

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  const locale = getLocale()
  return locale === "zh" ? (zh[key] ?? en[key]) : en[key]
}

const getStorage = (key: string) => {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const setStorage = (key: string, value: string | null) => {
  if (typeof localStorage === "undefined") return
  try {
    if (value !== null) {
      localStorage.setItem(key, value)
      return
    }
    localStorage.removeItem(key)
  } catch {
    return
  }
}

const MAC_SEED_FLAG = "opencode.seedMacServer"
// Opt-in gate for the tailnet Mac server (see builtInServers). `?seedMac=1`
// enables it for this browser and persists; `?seedMac=0` disables it.
const shouldSeedMac = (current: ServerConnection.Http) => {
  if (typeof window !== "undefined") {
    try {
      const p = new URLSearchParams(window.location.search)
      if (p.get("seedMac") === "1") setStorage(MAC_SEED_FLAG, "1")
      else if (p.get("seedMac") === "0") setStorage(MAC_SEED_FLAG, null)
    } catch {
      /* ignore */
    }
  }
  if (isMacUrl(current.http.url)) return true
  return getStorage(MAC_SEED_FLAG) === "1"
}

const readDefaultServerUrl = () => getStorage(DEFAULT_SERVER_URL_KEY)
const writeDefaultServerUrl = (url: string | null) => setStorage(DEFAULT_SERVER_URL_KEY, url)

const notify: Platform["notify"] = async (title, description, href) => {
  if (!("Notification" in window)) return

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission

  if (permission !== "granted") return

  const inView = document.visibilityState === "visible" && document.hasFocus()
  if (inView) return

  const notification = new Notification(title, {
    body: description ?? "",
    icon: "https://opencode.ai/favicon-96x96-v3.png",
  })

  notification.onclick = () => {
    handleNotificationClick(href)
    notification.close()
  }
}

const openLink: Platform["openLink"] = (url) => {
  window.open(url, "_blank")
}

const back: Platform["back"] = () => {
  window.history.back()
}

const forward: Platform["forward"] = () => {
  window.history.forward()
}

const restart: Platform["restart"] = async () => {
  window.location.reload()
}

const root = document.getElementById("root")
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const getCurrentUrl = () => {
  if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  return location.origin
}

const getDefaultUrl = () => {
  const lsDefault = readDefaultServerUrl()
  if (lsDefault) return lsDefault
  // Local dev UI connects to the LIVE main workspace (all projects/providers),
  // not an empty local backend. Set a `defaultServerUrl` in settings to override.
  if (import.meta.env.DEV) return CT100_SERVER_URL
  return getCurrentUrl()
}

const clearAuthToken = () => {
  const params = new URLSearchParams(location.search)
  if (!params.has("auth_token")) return
  params.delete("auth_token")
  history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : "") + location.hash)
}

const platform: Platform = {
  platform: "web",
  version: pkg.version,
  openLink,
  back,
  forward,
  restart,
  notify,
  getDefaultServer: async () => {
    const stored = readDefaultServerUrl()
    return stored ? ServerConnection.Key.make(stored) : null
  },
  setDefaultServer: writeDefaultServerUrl,
}

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `web@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "web",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" && !(import.meta.env.OPENCODE_CHANNEL === "prod" && i.name === "GlobalHandlers"),
      )
    },
  })
}

if (root instanceof HTMLElement) {
  const auth = authFromToken(new URLSearchParams(location.search).get("auth_token"))
  clearAuthToken()
  const server: ServerConnection.Http = {
    type: "http",
    authToken: !!auth,
    http: {
      url: getCurrentUrl(),
      ...auth,
    },
  }
  render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders>
          <AppInterface
            defaultServer={ServerConnection.Key.make(getDefaultUrl())}
            canonicalLocalServer={ServerConnection.key(server)}
            servers={builtInServers(server)}
            projectSeeds={projectSeeds(server)}
            disableHealthCheck
          />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
}
