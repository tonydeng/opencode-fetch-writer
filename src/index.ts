/**
 * opencode-fetch-writer
 *
 * Generic OpenCode plugin that rewrites outgoing HTTP headers (including
 * User-Agent) for one or more configured providers, by wrapping their
 * `options.fetch` through the official `config` hook.
 *
 * Why `options.fetch`? It is the final outbound choke point: headers set
 * here cannot be overridden by SDK defaults. This is not true for
 * `provider.options.headers` — some SDKs merge their own User-Agent after
 * yours, silently discarding the configured value.
 *
 * Features:
 *  - Single-provider mode (legacy, top-level `providerId` + rule fields)
 *  - Multi-provider mode (`providers` map of provider ID -> rule)
 *  - Rewrite the User-Agent to any target string
 *  - Strip unwanted headers (e.g. ones injected by intermediate layers)
 *  - Idempotently inject fallback headers (never overwrites existing values)
 *  - Marker guard against double-wrapping when the plugin gets loaded twice
 *    (auto-discovery in a plugins/ dir + an explicit entry in the config)
 *
 * Environment variables (all optional):
 *   FETCH_WRITER_UA      - fallback `uaTarget` for every provider that does
 *                          not set one explicitly
 *   FETCH_WRITER_DEBUG   - set to "1" to enable debug logging (stderr)
 */

import type { Plugin } from "@opencode-ai/plugin"

/** Per-provider rewrite rule (values in the `providers` map). */
export interface ProviderRule {
  /** Target User-Agent. Omit to leave the UA unchanged. */
  uaTarget?: string
  /** Header names to delete from outgoing requests. Default: [] */
  headersToStrip?: string[]
  /** Headers to inject when missing. Never overwrites existing values. Default: {} */
  headersToInject?: Record<string, string>
}

export interface FetchWriterOptions extends ProviderRule {
  /**
   * Legacy single-provider mode: the provider to wrap. Required unless
   * `providers` is set. Mutually exclusive with `providers`.
   */
  providerId?: string
  /**
   * Multi-provider mode: map of provider ID (key in the `provider` map)
   * to its rewrite rule. Mutually exclusive with `providerId`.
   */
  providers?: Record<string, ProviderRule>
  /** Enable debug logging to stderr. Default: false */
  debug?: boolean
}

/**
 * Marker guard: prevents double-wrapping when the plugin is loaded twice.
 * NOT exported: OpenCode's loader requires every module export to be a
 * function ("Plugin export is not a function" otherwise, v0.1.0 lesson).
 */
const MARKER = "__fetchWriterPatched"

type NormalizedRule = Required<Pick<ProviderRule, "headersToStrip" | "headersToInject">> & {
  uaTarget?: string
}

/** Normalize options into a providerId -> rule map. Returns undefined on config error. */
function normalize(options?: FetchWriterOptions): Map<string, NormalizedRule> | undefined {
  if (options?.providerId !== undefined && options?.providers !== undefined) {
    return undefined
  }
  const envUa = process.env.FETCH_WRITER_UA
  const rules = new Map<string, NormalizedRule>()

  if (options?.providerId !== undefined) {
    rules.set(options.providerId, {
      uaTarget: options.uaTarget ?? envUa,
      headersToStrip: options.headersToStrip ?? [],
      headersToInject: options.headersToInject ?? {},
    })
  } else if (options?.providers) {
    for (const [id, rule] of Object.entries(options.providers)) {
      rules.set(id, {
        uaTarget: rule?.uaTarget ?? envUa,
        headersToStrip: rule?.headersToStrip ?? [],
        headersToInject: rule?.headersToInject ?? {},
      })
    }
  }
  return rules
}

export const fetchWriter: Plugin = async (_input, options?: FetchWriterOptions) => {
  const rules = normalize(options)
  const debug = options?.debug === true || process.env.FETCH_WRITER_DEBUG === "1"

  const log = (msg: string): void => {
    if (debug) console.error(`[fetch-writer] ${msg}`)
  }

  return {
    config: async (config) => {
      if (rules === undefined) {
        console.error(
          "[fetch-writer] config error: `providerId` and `providers` are mutually exclusive, plugin inactive",
        )
        return
      }
      if (rules.size === 0) {
        console.error("[fetch-writer] no providerId/providers configured, plugin inactive")
        return
      }

      let patched = 0
      for (const [providerId, rule] of rules) {
        const provider = config.provider?.[providerId]
        if (!provider) {
          log(`provider "${providerId}" not found in config, skipping`)
          continue
        }

        const opts = (provider.options ??= {}) as Record<string, unknown>
        const existingFetch = opts.fetch as (typeof globalThis.fetch & { [key: string]: unknown }) | undefined
        if (typeof existingFetch?.[MARKER] === "boolean") {
          log(`provider "${providerId}": options.fetch already patched, skipping (marker guard)`)
          continue
        }

        const realFetch: typeof globalThis.fetch = existingFetch ?? globalThis.fetch.bind(globalThis)
        const { uaTarget, headersToStrip, headersToInject } = rule

        const wrapped = (async (req: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          try {
            // Support both fetch(url, init) and fetch(Request) call shapes
            const headers = new Headers(init?.headers ?? undefined)
            if (init?.headers === undefined && typeof Request !== "undefined" && req instanceof Request) {
              req.headers.forEach((v, k) => {
                if (!headers.has(k)) headers.set(k, v)
              })
            }

            if (uaTarget) {
              log(`user-agent: ${headers.get("user-agent")} -> ${uaTarget}`)
              headers.set("user-agent", uaTarget)
            }
            for (const name of headersToStrip) headers.delete(name)
            for (const [name, value] of Object.entries(headersToInject)) {
              if (!headers.has(name)) headers.set(name, value)
            }

            return realFetch(req, init ? { ...init, headers } : { headers })
          } catch (err) {
            log(`wrap failed, falling back to raw fetch: ${err}`)
            return realFetch(req, init)
          }
        }) as typeof globalThis.fetch & { [key: string]: unknown }

        wrapped[MARKER] = true
        opts.fetch = wrapped
        patched++
        // Always emit one activation line per provider so users can confirm the patch at startup
        console.error(`[fetch-writer] patched options.fetch for provider "${providerId}"`)
      }

      if (patched === 0) log("no providers matched, nothing patched")
    },
  }
}

export default fetchWriter
