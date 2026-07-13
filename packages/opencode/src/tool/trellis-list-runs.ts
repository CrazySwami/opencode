import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { TrellisRemoteClient } from "@/trellis/client"
import DESCRIPTION from "./trellis-list-runs.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({})

export const TrellisListRunsTool = Tool.define(
  "trellis_list_runs",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const res = yield* Effect.promise(() => new TrellisRemoteClient(ins.directory).listRuns())
          const fx = res.source === "fixture"
          const tag = fx ? " [FIXTURE]" : ""
          if (!res.ok) {
            return {
              title: `Trellis runs: unavailable${tag}`,
              metadata: { ok: false, source: res.source } as Record<string, unknown>,
              output: `Trellis runs unavailable${tag}: ${res.error}`,
            }
          }
          const lines = res.data.map(
            (r) => `- ${r.id} — ${r.title} [${r.status}] agent=${r.agentId}${r.linear ? ` (${r.linear})` : ""}`,
          )
          return {
            title: `Trellis runs: ${res.data.length}${tag}`,
            metadata: { ok: true, source: res.source, count: res.data.length } as Record<string, unknown>,
            output: [`Trellis runs${tag} (${res.data.length})`, ...lines, fx ? `\n(FIXTURE DATA.)` : ""]
              .filter(Boolean)
              .join("\n"),
          }
        }),
    }
  }),
)
