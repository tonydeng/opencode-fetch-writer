/**
 * Version-independent core: option shapes, normalization, and the header
 * rewrite itself.
 *
 * Nothing in this file imports an OpenCode SDK. Both the V1 entrypoint
 * (`server()` + `config` hook + `options.fetch` wrapping) and the V2 entrypoint
 * (`setup()` + `ctx.session.hook("http.request")`) reuse these pieces, so a
 * published package stays free of a hard runtime dependency on either SDK.
 */

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

export type NormalizedRule = {
  uaTarget?: string
  headersToStrip: string[]
  headersToInject: Record<string, string>
}

/** Log prefix shared by both entrypoints. */
export const LOG_PREFIX = "[fetch-writer]"

/**
 * Normalize options into a providerId -> rule map.
 *
 * Returns `undefined` when `providerId` and `providers` are both set, which the
 * entrypoints report as a configuration error.
 */
export function normalize(options?: FetchWriterOptions): Map<string, NormalizedRule> | undefined {
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

/** Resolve debug mode from options plus the FETCH_WRITER_DEBUG env var. */
export function debugEnabled(options?: FetchWriterOptions): boolean {
  return options?.debug === true || process.env.FETCH_WRITER_DEBUG === "1"
}

/**
 * Report an unusable option set. Both entrypoints call this before registering
 * anything, so a misconfigured plugin stays inactive instead of half-applying.
 */
export function reportConfigurationError(rules: Map<string, NormalizedRule> | undefined, log: (msg: string) => void) {
  if (rules === undefined) {
    console.error(
      `${LOG_PREFIX} config error: \`providerId\` and \`providers\` are mutually exclusive, plugin inactive`,
    )
    return
  }
  if (rules.size === 0) {
    console.error(`${LOG_PREFIX} no providerId/providers configured, plugin inactive`)
    return
  }
  log(`${rules.size} provider rule(s) loaded`)
}

/**
 * Apply one rule to an outbound header set, in place.
 *
 * This is the final choke point in both OpenCode generations: whatever is set
 * here cannot be overridden by SDK defaults afterwards.
 */
export function applyRule(headers: Headers, rule: NormalizedRule, log: (msg: string) => void): void {
  if (rule.uaTarget) {
    log(`user-agent: ${headers.get("user-agent")} -> ${rule.uaTarget}`)
    headers.set("user-agent", rule.uaTarget)
  }
  for (const name of rule.headersToStrip) headers.delete(name)
  for (const [name, value] of Object.entries(rule.headersToInject)) {
    if (!headers.has(name)) headers.set(name, value)
  }
}