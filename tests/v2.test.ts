import { describe, expect, test } from "bun:test"
import plugin from "../src/index"
import type { Plugin } from "@opencode/plugin"
import type { SessionHttpRequest } from "@opencode/plugin/promise/session"
import type { FetchWriterOptions } from "../src/rule"

/** Event shape the host passes to an `http.request` hook. */
type HookEvent = SessionHttpRequest

/**
 * Minimal stand-in for the V2 plugin context.
 *
 * `ctx.session.hook` records registrations instead of dispatching them, so a
 * test can assert both what got registered (name + providerID scoping) and what
 * the callback does to a real `Request`.
 */
function makeContext(options?: FetchWriterOptions) {
  const hooks: Array<{
    name: string
    providerID?: string
    callback: (event: HookEvent) => void | Promise<void>
  }> = []

  const ctx = {
    app: { name: "opencode", version: "2.0.23", channel: "stable" },
    location: { directory: "/tmp/project" },
    options: options ?? {},
    session: {
      hook: async (
        name: string,
        callback: (event: HookEvent) => void | Promise<void>,
        hookOptions?: { providerID?: string },
      ) => {
        hooks.push({ name, providerID: hookOptions?.providerID, callback })
        return { dispose: async () => {} }
      },
    },
  } as unknown as Plugin.Context

  return { ctx, hooks }
}

/** Build the event shape the real host passes to an `http.request` hook. */
function makeEvent(providerID: string, headers?: Record<string, string>): HookEvent {
  return {
    sessionID: "ses_test",
    agent: "build",
    model: { providerID, id: "model-1" },
    kind: "primary",
    request: new Request("https://gateway.example.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
    }),
  } as HookEvent
}

describe("V2 entrypoint (http.request hook)", () => {
  test("exposes a stable plugin id for the plugins control list", () => {
    expect(plugin.id).toBe("fetch-writer")
  })

  test("registers one http.request hook per provider, scoped by providerID", async () => {
    const { ctx, hooks } = makeContext({
      providers: { acme: { uaTarget: "app-a/1.0" }, corp: { uaTarget: "app-b/2.0" } },
    })
    await plugin.setup(ctx)

    expect(hooks.map((h) => [h.name, h.providerID])).toEqual([
      ["http.request", "acme"],
      ["http.request", "corp"],
    ])
  })

  test("rewrites UA, strips and injects headers on the outbound request", async () => {
    const { ctx, hooks } = makeContext({
      providerId: "acme",
      uaTarget: "my-app/1.0",
      headersToStrip: ["x-unwanted"],
      headersToInject: { "X-Custom": "yes" },
    })
    await plugin.setup(ctx)

    const event = makeEvent("acme", { "x-unwanted": "drop-me" })
    await hooks[0].callback(event)

    expect(event.request.headers.get("user-agent")).toBe("my-app/1.0")
    expect(event.request.headers.get("x-unwanted")).toBeNull()
    expect(event.request.headers.get("x-custom")).toBe("yes")
    // Untouched headers survive.
    expect(event.request.headers.get("content-type")).toBe("application/json")
  })

  test("does not touch another provider's request", async () => {
    const { ctx, hooks } = makeContext({ providerId: "acme", uaTarget: "my-app/1.0" })
    await plugin.setup(ctx)

    const event = makeEvent("corp", { "user-agent": "other/9.9" })
    await hooks[0].callback(event)

    expect(event.request.headers.get("user-agent")).toBe("other/9.9")
  })

  test("leaves UA untouched when uaTarget is omitted", async () => {
    const { ctx, hooks } = makeContext({ providerId: "acme" })
    await plugin.setup(ctx)

    const event = makeEvent("acme", { "user-agent": "original/2.0" })
    await hooks[0].callback(event)

    expect(event.request.headers.get("user-agent")).toBe("original/2.0")
  })

  test("never overwrites an existing injected header", async () => {
    const { ctx, hooks } = makeContext({ providerId: "acme", headersToInject: { "x-custom": "plugin-value" } })
    await plugin.setup(ctx)

    const event = makeEvent("acme", { "x-custom": "user-value" })
    await hooks[0].callback(event)

    expect(event.request.headers.get("x-custom")).toBe("user-value")
  })

  test("each provider keeps its own rule", async () => {
    const { ctx, hooks } = makeContext({
      providers: {
        acme: { uaTarget: "app-a/1.0", headersToStrip: ["x-unwanted"] },
        corp: { uaTarget: "app-b/2.0", headersToInject: { "x-corp": "yes" } },
      },
    })
    await plugin.setup(ctx)

    const acme = makeEvent("acme", { "x-unwanted": "drop" })
    await hooks[0].callback(acme)
    expect(acme.request.headers.get("user-agent")).toBe("app-a/1.0")
    expect(acme.request.headers.get("x-unwanted")).toBeNull()

    const corp = makeEvent("corp")
    await hooks[1].callback(corp)
    expect(corp.request.headers.get("user-agent")).toBe("app-b/2.0")
    expect(corp.request.headers.get("x-corp")).toBe("yes")
  })

  test("FETCH_WRITER_UA applies to providers without an explicit uaTarget", async () => {
    process.env.FETCH_WRITER_UA = "env-agent/9.0"
    try {
      const { ctx, hooks } = makeContext({
        providers: { acme: { uaTarget: "explicit/1.0" }, corp: {} },
      })
      await plugin.setup(ctx)

      const acme = makeEvent("acme")
      await hooks[0].callback(acme)
      const corp = makeEvent("corp")
      await hooks[1].callback(corp)

      expect(acme.request.headers.get("user-agent")).toBe("explicit/1.0")
      expect(corp.request.headers.get("user-agent")).toBe("env-agent/9.0")
    } finally {
      delete process.env.FETCH_WRITER_UA
    }
  })

  test("registers nothing when no provider is configured", async () => {
    const { ctx, hooks } = makeContext({})
    await plugin.setup(ctx)

    expect(hooks).toHaveLength(0)
  })

  test("registers nothing when providerId and providers are both set", async () => {
    const { ctx, hooks } = makeContext({
      providerId: "acme",
      providers: { acme: { uaTarget: "x/1.0" } },
    })
    await plugin.setup(ctx)

    expect(hooks).toHaveLength(0)
  })
})