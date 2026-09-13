/**
 * opencode-fetch-writer
 *
 * Generic OpenCode plugin that rewrites outgoing HTTP headers (including
 * User-Agent) for a configured provider, by wrapping its `options.fetch`
 * through the official `config` hook.
 *
 * Why `options.fetch`? It is the final outbound choke point: headers set
 * here cannot be overridden by SDK defaults. This is not true for
 * `provider.options.headers` — some SDKs merge their own User-Agent after
 * yours, silently discarding the configured value.
 *
 * Features:
 *  - Rewrite the User-Agent to any target string
 *  - Strip unwanted headers (e.g. ones injected by intermediate layers)
 *  - Idempotently inject fallback headers (never overwrites existing values)
 *  - Marker guard against double-wrapping when the plugin gets loaded twice
 *    (auto-discovery in a plugins/ dir + an explicit entry in the config)
 *
 * Environment variables (all optional):
 *   FETCH_WRITER_UA      - overrides the `uaTarget` option
 *   FETCH_WRITER_DEBUG   - set to "1" to enable debug logging (stderr)
 */

import type { Plugin } from "@opencode-ai/plugin"

export interface FetchWriterOptions {
  /** Provider ID (key in the `provider` map) whose fetch will be wrapped. Required to activate the plugin. */
  providerId?: string
  /** Target User-Agent string. Omit to leave the UA unchanged. */
  uaTarget?: string
  /** Header names to delete from outgoing requests. Default: [] */
  headersToStrip?: string[]
  /** Headers to inject when missing. Never overwrites existing values. Default: {} */
  headersToInject?: Record<string, string>
  /** Enable debug logging to stderr. Default: false */
  debug?: boolean
}

/**
 * Marker guard: prevents double-wrapping when the plugin is loaded twice.
 * NOT exported: OpenCode's loader requires every module export to be a
 * function ("Plugin export is not a function" otherwise, v0.1.0 lesson).
 */
const MARKER = "__fetchWriterPatched"

export const fetchWriter: Plugin = async (_input, options?: FetchWriterOptions) => {
  const providerId = options?.providerId
  const uaTarget = options?.uaTarget ?? process.env.FETCH_WRITER_UA
  const headersToStrip = options?.headersToStrip ?? []
  const headersToInject = options?.headersToInject ?? {}
  const debug = options?.debug === true || process.env.FETCH_WRITER_DEBUG === "1"

  const log = (msg: string): void => {
    if (debug) console.error(`[fetch-writer] ${msg}`)
  }

  return {
    config: async (config) => {
      if (!providerId) {
        console.error("[fetch-writer] no providerId configured, plugin inactive")
        return
      }
      const provider = config.provider?.[providerId]
      if (!provider) {
        log(`provider "${providerId}" not found in config, skipping`)
        return
      }

      const opts = (provider.options ??= {}) as Record<string, unknown>
      const existingFetch = opts.fetch as (typeof globalThis.fetch & { [key: string]: unknown }) | undefined
      if (typeof existingFetch?.[MARKER] === "boolean") {
        log("options.fetch already patched, skipping (marker guard)")
        return
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
      // Always emit one activation line so users can confirm the patch at startup
      console.error(`[fetch-writer] patched options.fetch for provider "${providerId}"`)
    },
  }
}

export default fetchWriter
