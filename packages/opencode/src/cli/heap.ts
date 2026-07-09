import path from "path"
import { writeHeapSnapshot } from "node:v8"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"

// Snapshot trigger threshold (RSS). Env-configurable so a capture can be armed
// at a low RSS (e.g. during a leak hunt) without a rebuild — set
// OPENCODE_HEAP_SNAPSHOT_LIMIT_MB. Defaults to 2GB.
const LIMIT = Number(process.env["OPENCODE_HEAP_SNAPSHOT_LIMIT_MB"] ?? "2048") * 1024 * 1024
// Sample interval; 20s (vs 60s) so a fast terminal spike is captured near its
// onset instead of after a watchdog recycle. Env-configurable.
const INTERVAL = Number(process.env["OPENCODE_HEAP_SNAPSHOT_INTERVAL_MS"] ?? "20000")

let timer: Timer | undefined
let lock = false
let armed = true

const mb = (n: number) => Math.round(n / 1024 / 1024)

export function start() {
  if (!Flag.OPENCODE_AUTO_HEAP_SNAPSHOT) return
  if (timer) return

  const run = async () => {
    if (lock) return

    const stat = process.memoryUsage()
    // Log the internal heap breakdown every tick. heapUsed≈rss ⇒ a real JS leak;
    // heapUsed≪rss (rss/anon high) ⇒ allocator/native retention. Greppable in the
    // service journal as `[heapmon]`.
    console.log(
      `[heapmon] rss=${mb(stat.rss)}MB heapUsed=${mb(stat.heapUsed)}MB heapTotal=${mb(stat.heapTotal)}MB external=${mb(stat.external)}MB arrayBuffers=${mb(stat.arrayBuffers)}MB`,
    )
    if (stat.rss <= LIMIT) {
      armed = true
      return
    }
    if (!armed) return

    lock = true
    armed = false
    const file = path.join(
      Global.Path.log,
      `heap-${process.pid}-${new Date().toISOString().replace(/[:.]/g, "")}.heapsnapshot`,
    )
    console.log(`[heapmon] rss ${mb(stat.rss)}MB > ${mb(LIMIT)}MB — writing heap snapshot to ${file}`)
    await Promise.resolve()
      .then(() => writeHeapSnapshot(file))
      .then(() => console.log(`[heapmon] heap snapshot written: ${file}`))
      .catch((err) => console.log(`[heapmon] heap snapshot failed: ${err}`))

    lock = false
  }

  timer = setInterval(() => {
    void run()
  }, INTERVAL)
  timer.unref?.()
}

export * as Heap from "./heap"
