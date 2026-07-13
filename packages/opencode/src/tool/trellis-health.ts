import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { TrellisRemoteClient } from "@/trellis/client"
import DESCRIPTION from "./trellis-health.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({})

export const TrellisHealthTool = Tool.define(
  "trellis_health",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const res = yield* Effect.promise(() => new TrellisRemoteClient(ins.directory).health())
          const fx = res.source === "fixture"
          const tag = fx ? " [FIXTURE]" : ""
          if (!res.ok) {
            return {
              title: `Trellis health: unavailable${tag}`,
              metadata: { ok: false, source: res.source } as Record<string, unknown>,
              output: `Trellis health unavailable${tag}: ${res.error}`,
            }
          }
          const h = res.data
          return {
            title: `Trellis: ${h.status}${tag}`,
            metadata: { ok: true, source: res.source, status: h.status } as Record<string, unknown>,
            output: [
              `Trellis health${tag}`,
              `- status: ${h.status}`,
              `- runtime: ${h.runtime ?? "?"}`,
              `- version: ${h.version ?? "?"}`,
              `- checkedAt: ${h.checkedAt}`,
              fx ? `\n(FIXTURE DATA — no live Trellis endpoint configured for this directory.)` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          }
        }),
    }
  }),
)
