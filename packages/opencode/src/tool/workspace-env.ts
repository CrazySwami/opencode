import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./workspace-env.txt"
import {
  readWorkspaceEnvRegistryPublic,
  validateDotenvText,
  workspaceEnvPath,
} from "@opencode-ai/core/workspace-env"

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literals(["list", "validate"])).annotate({
    description:
      "list = keys + metadata (never values); validate = check pasted dotenv text (keys/duplicates/malformed, no values). Defaults to list.",
  }),
  dotenv: Schema.optional(Schema.String).annotate({
    description: "Dotenv text for validate. Only key names and line validity are returned, never values.",
  }),
})

type Metadata = { action: "list" | "validate" }

export const WorkspaceEnvTool = Tool.define<typeof Parameters, Metadata, never>(
  "workspace_env",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const action = params.action ?? "list"
          const body =
            action === "validate"
              ? { action, validation: validateDotenvText(params.dotenv ?? "") }
              : (() => {
                  const registry = readWorkspaceEnvRegistryPublic()
                  return {
                    action,
                    path: workspaceEnvPath(),
                    count: registry.entries.length,
                    entries: registry.entries.map((entry) => ({
                      name: entry.name,
                      scope: entry.scope,
                      enabled: entry.enabled,
                      secret: entry.secret,
                      hasValue: entry.hasValue,
                      description: entry.description ?? null,
                      updatedAt: entry.updatedAt,
                    })),
                    note: "Values are never returned by this tool. To change a variable, propose it to the user; mutations are done in the Environment tab UI.",
                  }
                })()
          return {
            title: `workspace_env ${action}`,
            output: JSON.stringify(body, null, 2),
            metadata: { action },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
