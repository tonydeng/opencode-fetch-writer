import { describe, expect, test } from "bun:test"
import plugin from "../src/index"
import type { Plugin as PluginV1, PluginOptions } from "@opencode-ai/plugin"
import type { FetchWriterOptions } from "../src/rule"

// Marker literal duplicated here on purpose: neither src/v1.ts nor src/index.ts
// may export it (see the loader-contract test in index.test.ts), so tests assert
// on public behavior instead.
const MARKER = "__fetchWriterPatched"

// The V1 plugin never reads its first argument; a nullish cast keeps the tests
// free of a full PluginInput construction.
const input = undefined as unknown as Parameters<PluginV1>[0]

type ConfigParam = Parameters<NonNullable<Awaited<ReturnType<PluginV1>>["config"]>>[0]
type WrappedFetch = typeof globalThis.fetch & { [key: string]: unknown }

/**
 * Drive the default export the way OpenCode 1.18.29+ does: call `server()` and
 * keep the returned hooks.
 */
async function loadV1(options?: FetchWriterOptions) {
  // PluginOptions is an open record, so the typed options object needs the
  // widening cast the host itself performs at the boundary.
  return await plugin.server(input, options as PluginOptions | undefined)
}

function makeConfig(providerId: string): { config: ConfigParam; options: Record<string, unknown> } {
  const options: Record<string, unknown> = {}
  const config = {
    provider: { [providerId]: { options } },
  } as ConfigParam
  return { config, options }
}

/** A stand-in for the provider's own options.fetch, recording what it receives. */
function recordingFetch(seen: Headers[]): WrappedFetch {
  return (async (_req: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers))
    return new Response("ok")
  }) as WrappedFetch
}

describe("V1 entrypoint (config hook + options.fetch wrapping)", () => {
  test("rewrites UA, strips and injects headers, keeps the rest", async () => {
    const seen: Headers[] = []
    const options: Record<string, unknown> = { fetch: recordingFetch(seen) }
    const config = { provider: { acme: { options } } } as ConfigParam

    const hooks = await loadV1({
      providerId: "acme",
      uaTarget: "my-app/1.0",
      headersToStrip: ["x-unwanted"],
      headersToInject: { "X-Custom": "yes" },
    })
    await hooks.config?.(config)

    const wrapped = options.fetch as WrappedFetch
    expect(wrapped[MARKER]).toBe(true)

    await wrapped("https://example.com/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-unwanted": "drop-me" },
    })

    const h = seen[0]
    expect(h.get("user-agent")).toBe("my-app/1.0")
    expect(h.get("x-unwanted")).toBeNull()
    expect(h.get("x-custom")).toBe("yes")
    expect(h.get("content-type")).toBe("application/json")
  })

  test("leaves UA untouched when uaTarget is omitted", async () => {
    const seen: Headers[] = []
    const { config, options } = makeConfig("acme")
    options.fetch = recordingFetch(seen)

    const hooks = await loadV1({ providerId: "acme" })
    await hooks.config?.(config)
    await (options.fetch as WrappedFetch)("https://example.com", {
      headers: { "user-agent": "original/2.0" },
    })

    expect(seen[0].get("user-agent")).toBe("original/2.0")
  })

  test("never overwrites an existing injected header", async () => {
    const seen: Headers[] = []
    const { config, options } = makeConfig("acme")
    options.fetch = recordingFetch(seen)

    const hooks = await loadV1({ providerId: "acme", headersToInject: { "x-custom": "plugin-value" } })
    await hooks.config?.(config)
    await (options.fetch as WrappedFetch)("https://example.com", {
      headers: { "x-custom": "user-value" },
    })

    expect(seen[0].get("x-custom")).toBe("user-value")
  })

  test("config hook is idempotent (marker guard)", async () => {
    const { config, options } = makeConfig("acme")

    const hooks = await loadV1({ providerId: "acme" })
    await hooks.config?.(config)
    const first = options.fetch
    expect(first).toBeDefined()

    await hooks.config?.(config)
    expect(options.fetch).toBe(first)
  })

  test("copies headers from a Request object when init.headers is absent", async () => {
    const seen: Headers[] = []
    const { config, options } = makeConfig("acme")
    options.fetch = recordingFetch(seen)

    const hooks = await loadV1({ providerId: "acme", uaTarget: "my-app/1.0" })
    await hooks.config?.(config)

    const req = new Request("https://example.com", {
      method: "POST",
      headers: { "content-type": "application/json", "x-unwanted": "drop-me" },
    })
    await (options.fetch as WrappedFetch)(req)

    expect(seen[0].get("user-agent")).toBe("my-app/1.0")
    expect(seen[0].get("content-type")).toBe("application/json")
  })

  test("inactive when providerId is not configured", async () => {
    const { config, options } = makeConfig("acme")

    const hooks = await loadV1({})
    await hooks.config?.(config)

    expect(options.fetch).toBeUndefined()
  })

  test("skips when the provider does not exist", async () => {
    const { config, options } = makeConfig("acme")

    const hooks = await loadV1({ providerId: "other" })
    await hooks.config?.(config)

    expect(options.fetch).toBeUndefined()
  })

  test("patches multiple providers via the providers map", async () => {
    const seen: Record<string, Headers> = {}
    const mkProvider = (id: string) => {
      const options: Record<string, unknown> = {
        fetch: (async (_req: RequestInfo | URL, init?: RequestInit) => {
          seen[id] = new Headers(init?.headers)
          return new Response("ok")
        }) as WrappedFetch,
      }
      return [id, { options }] as const
    }
    const config = { provider: Object.fromEntries([mkProvider("acme"), mkProvider("corp")]) } as ConfigParam

    const hooks = await loadV1({
      providers: {
        acme: { uaTarget: "app-a/1.0", headersToStrip: ["x-unwanted"] },
        corp: { uaTarget: "app-b/2.0", headersToInject: { "x-corp": "yes" } },
      },
    })
    await hooks.config?.(config)

    const acmeFetch = (config.provider!["acme"].options as Record<string, unknown>).fetch as WrappedFetch
    const corpFetch = (config.provider!["corp"].options as Record<string, unknown>).fetch as WrappedFetch
    expect(acmeFetch[MARKER]).toBe(true)
    expect(corpFetch[MARKER]).toBe(true)

    await acmeFetch("https://example.com/a", { headers: { "x-unwanted": "drop" } })
    expect(seen["acme"].get("user-agent")).toBe("app-a/1.0")
    expect(seen["acme"].get("x-unwanted")).toBeNull()

    await corpFetch("https://example.com/b", {})
    expect(seen["corp"].get("user-agent")).toBe("app-b/2.0")
    expect(seen["corp"].get("x-corp")).toBe("yes")
  })

  test("providerId and providers are mutually exclusive", async () => {
    const { config, options } = makeConfig("acme")

    const hooks = await loadV1({ providerId: "acme", providers: { acme: { uaTarget: "x/1.0" } } })
    await hooks.config?.(config)

    expect(options.fetch).toBeUndefined()
  })

  test("FETCH_WRITER_UA applies to providers without an explicit uaTarget", async () => {
    process.env.FETCH_WRITER_UA = "env-agent/9.0"
    try {
      const seen: Record<string, Headers> = {}
      const mkProvider = (id: string) => {
        const options: Record<string, unknown> = {
          fetch: (async (_req: RequestInfo | URL, init?: RequestInit) => {
            seen[id] = new Headers(init?.headers)
            return new Response("ok")
          }) as WrappedFetch,
        }
        return [id, { options }] as const
      }
      const config = { provider: Object.fromEntries([mkProvider("acme"), mkProvider("corp")]) } as ConfigParam

      const hooks = await loadV1({ providers: { acme: { uaTarget: "explicit/1.0" }, corp: {} } })
      await hooks.config?.(config)

      const acmeFetch = (config.provider!["acme"].options as Record<string, unknown>).fetch as WrappedFetch
      const corpFetch = (config.provider!["corp"].options as Record<string, unknown>).fetch as WrappedFetch
      await acmeFetch("https://example.com/a", {})
      await corpFetch("https://example.com/b", {})
      expect(seen["acme"].get("user-agent")).toBe("explicit/1.0")
      expect(seen["corp"].get("user-agent")).toBe("env-agent/9.0")
    } finally {
      delete process.env.FETCH_WRITER_UA
    }
  })

  test("providers missing from config are skipped, others still patched", async () => {
    const { config, options } = makeConfig("acme")

    const hooks = await loadV1({ providers: { acme: { uaTarget: "app-a/1.0" }, ghost: { uaTarget: "x/1.0" } } })
    await hooks.config?.(config)

    expect((options.fetch as WrappedFetch)[MARKER]).toBe(true)
  })
})