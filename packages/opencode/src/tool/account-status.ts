import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./account-status.txt"

export const Parameters = Schema.Struct({
  detail: Schema.optional(Schema.Literals(["summary", "environment"])).annotate({
    description: "Level of account/status detail. Defaults to summary.",
  }),
})

type Metadata = {
  detail: "summary" | "environment"
}

export const AccountStatusTool = Tool.define<typeof Parameters, Metadata, never>(
  "account_status",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const detail = params.detail ?? "summary"
          const status = {
            hostname: process.env.OPENCODE_HOSTNAME ?? null,
            openDesignConfigured: !!(
              process.env.OD_API_TOKEN ||
              process.env.OPENCODE_OPEN_DESIGN_TOKEN ||
              process.env.OD_DAEMON_URL ||
              process.env.OPENCODE_OPEN_DESIGN_DAEMON_URL
            ),
            browserHome: process.env.OPENCODE_BROWSER_HOME ?? null,
            macViewConfigured: !!process.env.OPENCODE_MAC_VIEW_URL,
            playwrightCLI: process.env.OPENCODE_PLAYWRIGHT_CLI ?? "npx -y @playwright/cli",
            tools: [
              "browser",
              "terminal",
              "open_design",
              "mac_view",
              "resource_status",
              "artifact",
              "file_browser",
              "account_status",
            ],
            ...(detail === "environment"
              ? {
                  env: {
                    OD_DAEMON_URL: process.env.OD_DAEMON_URL ? "[set]" : "[unset]",
                    OD_API_TOKEN: process.env.OD_API_TOKEN ? "[set]" : "[unset]",
                    OPENCODE_OPEN_DESIGN_DAEMON_URL: process.env.OPENCODE_OPEN_DESIGN_DAEMON_URL ? "[set]" : "[unset]",
                    OPENCODE_OPEN_DESIGN_TOKEN: process.env.OPENCODE_OPEN_DESIGN_TOKEN ? "[set]" : "[unset]",
                    OPENCODE_MAC_VIEW_URL: process.env.OPENCODE_MAC_VIEW_URL ? "[set]" : "[unset]",
                    OPENCODE_MAC_RESOURCE_HOST: process.env.OPENCODE_MAC_RESOURCE_HOST ? "[set]" : "[unset]",
                  },
                }
              : {}),
          }
          return {
            title: "account status",
            output: JSON.stringify(status, null, 2),
            metadata: { detail },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
