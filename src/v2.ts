/**
 * OpenCode V2 entrypoint.
 *
 * V2 removed the mutable global config object and the `config` hook that V1
 * used to reach `provider.options.fetch`. The replacement is the session HTTP
 * hook: `ctx.session.hook("http.request", …)` receives the assembled outbound
 * `Request` immediately before dispatch, and mutating `event.request.headers`
 * there is the last word — nothing in the provider package or the runtime can
 * merge a different User-Agent over it afterwards.
 *
 * Registering an `http.request` hook also pins the provider to the HTTP
 * transport (OpenCode keeps websocket routes on HTTP so each request stays
 * observable), which is what a header-rewriting plugin wants anyway.
 *
 * The hook carries `model.providerID`, so one registration scoped with
 * `{ providerID }` replaces V1's "look the provider up in config, then patch
 * its fetch" flow. Unknown or inactive provider IDs simply never fire.
 */

// Type-only import: `@opencode/plugin` is a peer of the published package, not
// a runtime dependency. `Plugin.define` is the identity function at runtime, so
// the object literal below is what actually loads. This also keeps a V1-only
// install working, where `@opencode/plugin` is absent entirely.
import type { Plugin as OpencodePlugin } from "@opencode/plugin"
import { LOG_PREFIX, applyRule, debugEnabled, normalize, reportConfigurationError } from "./rule.js"
import type { FetchWriterOptions } from "./rule.js"

/**
 * Stable plugin ID. V2 identifies plugins by this value in status output and
 * in the `plugins` control list (`"-fetch-writer"` disables it).
 */
export const PLUGIN_ID = "fetch-writer"

/**
 * The V2 plugin definition.
 *
 * `Plugin.define` is the identity function at runtime; it exists so the object
 * type-checks against the published V2 contract.
 */
export const fetchWriterV2: OpencodePlugin.Plugin = {
  id: PLUGIN_ID,
  async setup(ctx: OpencodePlugin.Context) {
    const options = ctx.options as FetchWriterOptions | undefined
    const rules = normalize(options)
    const debug = debugEnabled(options)
    const log = (msg: string): void => {
      if (debug) console.error(`${LOG_PREFIX} ${msg}`)
    }

    reportConfigurationError(rules, log)
    if (rules === undefined || rules.size === 0) return

    for (const [providerID, rule] of rules) {
      await ctx.session.hook(
        "http.request",
        (event) => {
          // Scoped registration already filters by provider; the explicit check
          // keeps a mis-scoped hook from touching another provider's traffic.
          if (event.model.providerID !== providerID) return
          applyRule(event.request.headers, rule, log)
        },
        { providerID },
      )
      // One activation line per provider, same signal users rely on in V1.
      console.error(`${LOG_PREFIX} registered http.request hook for provider "${providerID}"`)
    }

    log(`OpenCode ${ctx.app.version}, location ${ctx.location.directory}`)
  },
} as const