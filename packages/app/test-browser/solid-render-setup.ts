import { plugin } from "bun"
import { transformSync } from "@babel/core"
import solidPreset from "babel-preset-solid"
import typescriptPreset from "@babel/preset-typescript"
import { readFileSync } from "node:fs"

// Bun test's own transpiler doesn't know Vite's `?worker` / `?worker&url` asset
// suffixes. Files that pull those in transitively (e.g. markdown/shiki worker
// setup deep in @opencode-ai/session-ui) fail to import outside of Vite's
// pipeline. Stub them to an empty module so the rest of the import graph -
// which render tests don't actually exercise - can still load under bun test.
plugin({
  name: "stub-vite-worker-url",
  setup(build) {
    build.onResolve({ filter: /\?worker(&url)?$/ }, (args) => {
      return { path: args.path, namespace: "stub-worker" }
    })
    build.onLoad({ filter: /.*/, namespace: "stub-worker" }, () => {
      return { contents: "export default '';", loader: "js" }
    })
  },
})

// Solid JSX needs a compile-time transform (babel-preset-solid) that turns
// JSX into imperative DOM-building code with fine-grained reactivity - unlike
// React's runtime jsx-runtime, it can't just be interpreted. Vite gets this
// via vite-plugin-solid; bun test needs its own transform, so we run
// babel-preset-solid (+ TS type stripping) over .tsx files here.
plugin({
  name: "solid-jsx",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, (args) => {
      const source = readFileSync(args.path, "utf8")
      const result = transformSync(source, {
        filename: args.path,
        presets: [[typescriptPreset, { isTSX: true, allExtensions: true }], [solidPreset, {}]],
        babelrc: false,
        configFile: false,
        sourceMaps: false,
      })
      return { contents: result?.code ?? source, loader: "js" }
    })
  },
})
