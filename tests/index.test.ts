import { expect, test } from "bun:test"
import plugin from "../src/index"

// OpenCode's V1 loader iterates Object.values(mod) and throws
// "Plugin export is not a function" unless EVERY export is a function
// (or an object exposing a .server function). Guards against regressions
// like exporting a non-function constant (v0.1.0 shipped `export const MARKER`)
// or re-exporting named symbols alongside the dual default export.
test("every export satisfies the OpenCode V1 loader contract", async () => {
  const mod = await import("../src/index")
  const values = Object.values(mod)
  expect(values.length).toBeGreaterThan(0)
  for (const entry of values) {
    const isFn = typeof entry === "function"
    const isServerObj =
      typeof entry === "object" && entry !== null && typeof (entry as { server?: unknown }).server === "function"
    expect(isFn || isServerObj).toBe(true)
  }
})

// V2 reads the default export's `id` and calls `setup(ctx)`. V1 reads the
// `server` member. Both must be present on the same object, which is what lets
// one published package serve OpenCode 1.18.29+ and OpenCode 2.
test("the default export satisfies both the V1 and V2 plugin contracts", () => {
  expect(typeof plugin.id).toBe("string")
  expect(plugin.id.length).toBeGreaterThan(0)
  expect(typeof plugin.setup).toBe("function")
  expect(typeof plugin.server).toBe("function")
})