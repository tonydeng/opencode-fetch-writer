/**
 * opencode-fetch-writer
 *
 * Generic OpenCode plugin that rewrites outgoing HTTP headers (including
 * User-Agent) for one or more configured providers.
 *
 * Why hook the outbound request instead of `provider.options.headers`? Some
 * SDKs merge their own default User-Agent *after* your configured headers, so
 * the gateway never sees the value you set. Both generations below hook the
 * last point where headers are still editable:
 *
 *  - V1 wraps the provider's `options.fetch` through the `config` hook.
 *  - V2 registers `ctx.session.hook("http.request", …)` and mutates the
 *    assembled `Request` immediately before dispatch.
 *
 * Features:
 *  - Single-provider mode (top-level `providerId` + rule fields)
 *  - Multi-provider mode (`providers` map of provider ID -> rule)
 *  - Rewrite the User-Agent to any target string
 *  - Strip unwanted headers (e.g. ones injected by intermediate layers)
 *  - Idempotently inject fallback headers (never overwrites existing values)
 *
 * Environment variables (all optional):
 *   FETCH_WRITER_UA      - fallback `uaTarget` for every provider that does
 *                          not set one explicitly
 *   FETCH_WRITER_DEBUG   - set to "1" to enable debug logging (stderr)
 *
 * This module deliberately exports ONLY the default export. The V1 loader
 * iterates every module export and rejects anything that is neither a function
 * nor an object exposing `server()` (the v0.1.0 "Plugin export is not a
 * function" lesson), so named exports would break V1 loading.
 */

import { fetchWriter } from "./v1.js"
import { fetchWriterV2 } from "./v2.js"
import type { FetchWriterOptions } from "./rule.js"

/**
 * Structural type of the dual entrypoint.
 *
 * Declared locally instead of re-exporting the SDK types so the published
 * `dist/index.d.ts` stays resolvable when only one of the two optional peer
 * packages is installed.
 */
export interface FetchWriterPlugin {
  /** V2 plugin identity, used by the `plugins` control list. */
  readonly id: string
  /** V2 entrypoint. `setup` may return a cleanup function; this plugin keeps none. */
  setup(ctx: unknown): unknown
  /** V1 entrypoint (OpenCode 1.18.29+). */
  server(input?: unknown, options?: FetchWriterOptions): Promise<{ config(config: unknown): Promise<void> }>
}

/**
 * One default export serving both OpenCode generations.
 *
 *  - V2 reads `id` and calls `setup(ctx)`.
 *  - V1 (1.18.29+) detects the `server()` member, calls it with
 *    `(input, options)`, and uses the returned `config` hook.
 */
const fetchWriterPlugin: FetchWriterPlugin = {
  ...fetchWriterV2,
  server: fetchWriter as FetchWriterPlugin["server"],
}

export default fetchWriterPlugin