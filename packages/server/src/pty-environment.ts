export * as PtyEnvironment from "./pty-environment"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { workspaceEnvForProcess } from "@opencode-ai/core/workspace-env"

export interface Interface {
  readonly get: (input: { directory: string; cwd: string }) => Effect.Effect<Record<string, string>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ServerPtyEnvironment") {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    get: (input) =>
      Effect.sync(() =>
        workspaceEnvForProcess({
          directory: input.directory,
          cwd: input.cwd,
          surface: "terminal",
        }),
      ),
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
