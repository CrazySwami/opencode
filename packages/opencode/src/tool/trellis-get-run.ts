import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { TrellisRemoteClient } from "@/trellis/client"
import DESCRIPTION from "./trellis-get-run.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  id: Schema.String.annotate({ description: "The Trellis run id (e.g. from trellis_list_runs)." }),
})

export const TrellisGetRunTool = Tool.define(
  "trellis_get_run",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { id: string }, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const res = yield* Effect.promise(() => new TrellisRemoteClient(ins.directory).getRun(params.id))
          const fx = res.source === "fixture"
          const tag = fx ? " [FIXTURE]" : ""
          if (!res.ok) {
            return {
              title: `Trellis run ${params.id}: unavailable${tag}`,
              metadata: { ok: false, source: res.source } as Record<string, unknown>,
              output: `Trellis run ${params.id} unavailable${tag}: ${res.error}`,
            }
          }
          const r = res.data
          const steps = r.steps.map((s) => `  - ${s.at} [${s.kind}] ${s.summary}`)
          return {
            title: `Trellis run ${r.id}: ${r.status}${tag}`,
            metadata: { ok: true, source: res.source, status: r.status, agentId: r.agentId } as Record<string, unknown>,
            output: [
              `Trellis run ${r.id}${tag}`,
              `- title: ${r.title}`,
              `- agent: ${r.agentId}`,
              `- status: ${r.status}`,
              `- started: ${r.startedAt ?? "?"}  finished: ${r.finishedAt ?? "—"}`,
              r.linear ? `- linear: ${r.linear}` : "",
              `- steps:`,
              ...steps,
              fx ? `\n(FIXTURE DATA.)` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          }
        }),
    }
  }),
)
