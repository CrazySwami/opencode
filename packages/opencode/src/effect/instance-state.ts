import { Effect, ScopedCache, Scope } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { registerDisposer } from "./instance-registry"
import { WorkspaceContext } from "@/control-plane/workspace-context"

const TypeId = "~opencode/InstanceState"

export interface InstanceState<A, E = never, R = never> {
  readonly [TypeId]: typeof TypeId
  readonly cache: ScopedCache.ScopedCache<string, A, E, R>
}

export const context = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die(new Error("InstanceRef not provided"))
  return ctx
})

export const workspaceID = Effect.gen(function* () {
  return (yield* WorkspaceRef) ?? WorkspaceContext.workspaceID
})

export const directory = Effect.map(context, (ctx) => ctx.directory)

// Per-directory instance state (LSP servers, MCP connections, config, providers,
// etc.) is cached keyed by directory. This was `capacity: Number.POSITIVE_INFINITY`
// — every project directory ever touched stayed resident forever, so the server's
// RSS climbed without bound across many dirs / reconnects (the CT100 memory leak).
// Now bounded: the ScopedCache keeps the N most-recently-used directories and
// LRU-evicts the stalest past the cap. Eviction closes that entry's scope — its
// LSP/MCP subprocesses shut down and its in-memory state frees; nothing on disk
// (sessions/messages) is touched, and the next access re-initializes it lazily.
//
// IMPORTANT (per Codex review): LRU refreshes recency on access but does NOT
// ref-count/pin in-flight work — `checkCapacity` closes the stalest scope with no
// reader check, and a directory whose run is mid-flight but not re-touching the
// cache could be evicted (its SessionRunState finalizer cancels the runner). So
// the cap is set generously (default 64) — comfortably above the realistic number
// of concurrently-active project dirs incl. a reconnect storm — to make evicting
// an active dir effectively impossible while still bounding total memory. Tune via
// OPENCODE_INSTANCE_CACHE_CAPACITY. Parse defensively: a non-finite/≤0 env value
// must fall back to the default, NOT become NaN (which the cache treats as
// unlimited → silently reinstates the leak).
const DEFAULT_CACHE_CAPACITY = 64
const CACHE_CAPACITY = (() => {
  const raw = process.env["OPENCODE_INSTANCE_CACHE_CAPACITY"]
  if (raw === undefined) return DEFAULT_CACHE_CAPACITY
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_CACHE_CAPACITY
})()

export const make = <A, E = never, R = never>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
): Effect.Effect<InstanceState<A, E, Exclude<R, Scope.Scope>>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const cache = yield* ScopedCache.make<string, A, E, R>({
      capacity: CACHE_CAPACITY,
      lookup: () =>
        Effect.gen(function* () {
          return yield* init(yield* context)
        }),
    })

    const off = registerDisposer((directory) => Effect.runPromise(ScopedCache.invalidate(cache, directory)))
    yield* Effect.addFinalizer(() => Effect.sync(off))

    return {
      [TypeId]: TypeId,
      cache,
    }
  })

export const get = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.get(self.cache, yield* directory)
  })

export const use = <A, E, R, B>(self: InstanceState<A, E, R>, select: (value: A) => B) => Effect.map(get(self), select)

export const useEffect = <A, E, R, B, E2, R2>(
  self: InstanceState<A, E, R>,
  select: (value: A) => Effect.Effect<B, E2, R2>,
) => Effect.flatMap(get(self), select)

export const has = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.has(self.cache, yield* directory)
  })

export const invalidate = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.invalidate(self.cache, yield* directory)
  })

export * as InstanceState from "./instance-state"
