/**
 * OpenCode V1 entrypoint.
 *
 * V1 hands plugins one mutable global config object and no outbound-request
 * hook that survives SDK header merging, so the only reliable choke point is
 * the provider's own `options.fetch`: headers set there cannot be overridden by
 * SDK defaults afterwards.
 *
 * Shape: `server(input, options)` returning `{ config }`. Loaded by OpenCode
 * 1.18.29+ (the object entrypoint); older 1.x releases expect a bare function
 * export, which `src/index.ts` also provides.
 */

import type { Plugin } from "@opencode-ai/plugin"
import {
  LOG_PREFIX,
  applyRule,
  debugEnabled,
  normalize,
  reportConfigurationError,
  type FetchWriterOptions,
} from "./rule.js"

/**
 * Marker guard: prevents double-wrapping when the plugin is loaded twice.
 * NOT exported: OpenCode's loader requires every module export to be a
 * function ("Plugin export is not a function" otherwise, v0.1.0 lesson).
 */
const MARKER = "__fetchWriterPatched"

/**
 * Marker on the wrapped fetch is the only V1-specific state, so a plugin
 * loaded through both auto-discovery and an explicit config entry still wraps
 * each provider exactly once.
 */
export function patchProviderFetch(
  providerId: string,
  options: Record<string, unknown> | undefined,
  rule: { uaTarget?: string; headersToStrip: string[]; headersToInject: Record<string, string> },
  log: (msg: string) => void,
): boolean {
  const opts = (options ??= {}) as Record<string, unknown>
  const existingFetch = opts.fetch as (typeof globalThis.fetch & { [key: string]: unknown }) | undefined
  if (typeof existingFetch?.[MARKER] === "boolean") {
    log(`provider "${providerId}": options.fetch already patched, skipping (marker guard)`)
    return false
  }

  const realFetch: typeof globalThis.fetch = existingFetch ?? globalThis.fetch.bind(globalThis)

  const wrapped = (async (req: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      // Support both fetch(url, init) and fetch(Request) call shapes
      const headers = new Headers(init?.headers ?? undefined)
      if (init?.headers === undefined && typeof Request !== "undefined" && req instanceof Request) {
        req.headers.forEach((v, k) => {
          if (!headers.has(k)) headers.set(k, v)
        })
      }

      applyRule(headers, rule, log)

      return realFetch(req, init ? { ...init, headers } : { headers })
    } catch (err) {
      log(`wrap failed, falling back to raw fetch: ${err}`)
      return realFetch(req, init)
    }
  }) as typeof globalThis.fetch & { [key: string]: unknown }

  wrapped[MARKER] = true
  opts.fetch = wrapped
  return true
}

/** The V1 plugin function. Also exported standalone for pre-1.18.29 loaders. */
export const fetchWriter: Plugin = async (_input, options?: FetchWriterOptions) => {
  const rules = normalize(options)
  const debug = debugEnabled(options)
  const log = (msg: string): void => {
    if (debug) console.error(`${LOG_PREFIX} ${msg}`)
  }

  return {
    config: async (config) => {
      reportConfigurationError(rules, log)
      if (rules === undefined || rules.size === 0) return

      let patched = 0
      for (const [providerId, rule] of rules) {
        const provider = config.provider?.[providerId]
        if (!provider) {
          log(`provider "${providerId}" not found in config, skipping`)
          continue
        }

        if (!patchProviderFetch(providerId, provider.options as Record<string, unknown>, rule, log)) continue
        patched++
        // Always emit one activation line per provider so users can confirm the patch at startup
        console.error(`${LOG_PREFIX} patched options.fetch for provider "${providerId}"`)
      }

      if (patched === 0) log("no providers matched, nothing patched")
    },
  }
}