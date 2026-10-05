/**
 * Post-build loader-contract check.
 *
 * The v0.1.0 release shipped a non-function export and OpenCode rejected the
 * plugin at load time, silently. Unit tests import from `src/`, so they cannot
 * catch a packaging or entrypoint mistake. This script runs against `dist/`
 * with the two real loader contracts:
 *
 *   - V1 (opencode 1.x): every module export must be a function, or an object
 *     exposing a `server()` function.
 *   - V2: the default export must carry a stable `id` and a `setup()` that
 *     registers the rewrite hook per provider.
 *
 * Run after `bun run build`: `node scripts/verify-package.mjs`
 */

import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"

const entry = pathToFileURL(resolve(process.argv[2] ?? "dist/index.js")).href
const mod = await import(entry)

/** The V1 loader's per-export check, from the opencode 1.18.x runtime. */
function pluginFunctionOf(entry) {
  if (typeof entry === "function") return entry
  if (!entry || typeof entry !== "object" || !("server" in entry)) return undefined
  if (typeof entry.server !== "function") return undefined
  return entry.server
}

const v1Plugins = []
const seen = new Set()
for (const entry of Object.values(mod)) {
  if (seen.has(entry)) continue
  seen.add(entry)
  const fn = pluginFunctionOf(entry)
  assert.ok(fn, "Plugin export is not a function")
  v1Plugins.push(fn)
}
assert.ok(v1Plugins.length > 0, "no plugin export found")
console.log(`V1 loader contract: ${v1Plugins.length} plugin(s) accepted`)

/** The rewrite both entrypoints must perform on an outbound header set. */
function assertRewritten(headers, label) {
  assert.equal(headers.get("user-agent"), "my-app/1.0", `${label}: user-agent not rewritten`)
  assert.equal(headers.get("x-bad"), null, `${label}: header not stripped`)
  assert.equal(headers.get("x-ok"), "1", `${label}: header not injected`)
  assert.equal(headers.get("keep"), "yes", `${label}: clobbered an unrelated header`)
}

const rules = {
  providerId: "acme",
  uaTarget: "my-app/1.0",
  headersToStrip: ["x-bad"],
  headersToInject: { "X-Ok": "1" },
}

// --- V1 --------------------------------------------------------------------
const seenV1 = []
const v1Options = {
  fetch: async (_input, init) => {
    seenV1.push(new Headers(init?.headers))
    return new Response("ok")
  },
}
const v1Hooks = await v1Plugins[0](undefined, rules)
await v1Hooks.config({ provider: { acme: { options: v1Options } } })
assert.equal(v1Options.fetch.__fetchWriterPatched, true, "V1: options.fetch was not patched")
await v1Options.fetch("https://gateway.example.com", { headers: { "x-bad": "drop", keep: "yes" } })
assertRewritten(seenV1[0], "V1")
console.log("V1 entrypoint: options.fetch patched and rewriting headers")

// --- V2 --------------------------------------------------------------------
const plugin = mod.default
assert.equal(typeof plugin.id, "string", "V2: plugin.id missing")
assert.ok(plugin.id.length > 0, "V2: plugin.id is empty")
assert.equal(typeof plugin.setup, "function", "V2: setup() missing")

const registrations = []
const ctx = {
  app: { name: "opencode", version: "2.0.0", channel: "stable" },
  location: { directory: process.cwd() },
  options: rules,
  session: {
    hook: async (name, callback, hookOptions) => {
      registrations.push({ name, providerID: hookOptions?.providerID, callback })
      return { dispose: async () => {} }
    },
  },
}

const cleanup = await plugin.setup(ctx)
assert.ok(cleanup === undefined || typeof cleanup === "function", "V2: bad cleanup return value")
assert.equal(registrations.length, 1, "V2: expected one hook registration")
assert.equal(registrations[0].name, "http.request", "V2: wrong hook name")
assert.equal(registrations[0].providerID, "acme", "V2: hook is not scoped to the provider")

const request = new Request("https://gateway.example.com/v1/chat/completions", {
  method: "POST",
  headers: { "user-agent": "opencode/2.0.0", "x-bad": "drop", keep: "yes" },
})
await registrations[0].callback({
  sessionID: "ses_test",
  agent: "build",
  model: { providerID: "acme", id: "model-1" },
  kind: "primary",
  request,
})
assertRewritten(request.headers, "V2")

// A hook scoped to one provider must leave other providers alone.
const other = new Request("https://other.example.com", { headers: { "user-agent": "keep/1.0" } })
await registrations[0].callback({
  sessionID: "ses_test",
  agent: "build",
  model: { providerID: "corp", id: "model-2" },
  kind: "primary",
  request: other,
})
assert.equal(other.headers.get("user-agent"), "keep/1.0", "V2: touched another provider's request")

console.log(`V2 entrypoint: id="${plugin.id}", http.request@acme rewriting headers`)
console.log("\nOK: dist satisfies both OpenCode loader contracts")