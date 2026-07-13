import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { TrellisRemoteClient } from "@/trellis/client"
import DESCRIPTION from "./trellis-get-report.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  runId: Schema.String.annotate({ description: "The Trellis run id whose OpenBook report to fetch." }),
})

export const TrellisGetReportTool = Tool.define(
  "trellis_get_report",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { runId: string }, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const res = yield* Effect.promise(() => new TrellisRemoteClient(ins.directory).getReport(params.runId))
          const fx = res.source === "fixture"
          const tag = fx ? " [FIXTURE]" : ""
          if (!res.ok) {
            return {
              title: `Trellis report ${params.runId}: unavailable${tag}`,
              metadata: { ok: false, source: res.source } as Record<string, unknown>,
              output: `Trellis report for ${params.runId} unavailable${tag}: ${res.error}`,
            }
          }
          const rep = res.data
          return {
            title: `Trellis report: ${rep.title}${tag}`,
            metadata: { ok: true, source: res.source, format: rep.format, runId: rep.runId } as Record<string, unknown>,
            output: [
              `Trellis report${tag} — ${rep.format}, generated ${rep.generatedAt}`,
              fx ? `(FIXTURE DATA.)\n` : "",
              rep.body,
            ]
              .filter(Boolean)
              .join("\n"),
          }
        }),
    }
  }),
)
