import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { TrellisRemoteClient } from "@/trellis/client"
import DESCRIPTION from "./trellis-list-agents.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({})

export const TrellisListAgentsTool = Tool.define(
  "trellis_list_agents",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const res = yield* Effect.promise(() => new TrellisRemoteClient(ins.directory).listAgents())
          const fx = res.source === "fixture"
          const tag = fx ? " [FIXTURE]" : ""
          if (!res.ok) {
            return {
              title: `Trellis agents: unavailable${tag}`,
              metadata: { ok: false, source: res.source } as Record<string, unknown>,
              output: `Trellis agents unavailable${tag}: ${res.error}`,
            }
          }
          const lines = res.data.map((a) => `- ${a.name} (${a.id}) — role: ${a.role ?? "?"}, status: ${a.status ?? "?"}`)
          return {
            title: `Trellis agents: ${res.data.length}${tag}`,
            metadata: { ok: true, source: res.source, count: res.data.length } as Record<string, unknown>,
            output: [`Trellis agents${tag} (${res.data.length})`, ...lines, fx ? `\n(FIXTURE DATA.)` : ""]
              .filter(Boolean)
              .join("\n"),
          }
        }),
    }
  }),
)
