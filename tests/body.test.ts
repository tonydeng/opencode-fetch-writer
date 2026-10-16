import { describe, expect, test } from "bun:test"
import { readRequestBody, rewriteRequestBody, wrapResponseRewrite } from "../src/body"

const log = (): void => {}

type FnCall = { name: string; arguments?: string; parameters?: unknown }
type ChatPayload = {
  model?: string
  messages?: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id?: string; type?: string; function: FnCall }> }>
  tools?: Array<{ type: string; function: FnCall }>
  tool_choice?: { type: string; function: FnCall }
}

function makeBody(): string {
  return JSON.stringify({
    model: "test",
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "write", arguments: "{}" } }],
      },
    ],
    tools: [
      { type: "function", function: { name: "write", parameters: { type: "object" } } },
      { type: "function", function: { name: "skill", parameters: { type: "object" } } },
    ],
    tool_choice: { type: "function", function: { name: "skill" } },
  } satisfies ChatPayload)
}

describe("rewriteRequestBody", () => {
  test("suffixes tools, history tool_calls and named tool_choice; builds reverse map", () => {
    const result = rewriteRequestBody(makeBody(), "_r", log)
    expect(result).toBeDefined()
    const parsed = JSON.parse(result!.body) as ChatPayload
    expect(parsed.tools!.map((t) => t.function.name)).toEqual(["write_r", "skill_r"])
    expect(parsed.messages![1].tool_calls![0].function.name).toBe("write_r")
    expect(parsed.tool_choice!.function.name).toBe("skill_r")
    expect(result!.reverseMap.get("write_r")).toBe("write")
    expect(result!.reverseMap.get("skill_r")).toBe("skill")
  })

  test("returns undefined when there is no tools array", () => {
    const body = JSON.stringify({ model: "test", messages: [{ role: "user", content: "hi" }] })
    expect(rewriteRequestBody(body, "_r", log)).toBeUndefined()
  })

  test("returns undefined on invalid JSON (fail-open)", () => {
    expect(rewriteRequestBody("{not json", "_r", log)).toBeUndefined()
  })

  test("skips malformed tool entries without dropping the rest", () => {
    const body = JSON.stringify({
      tools: [null, { type: "function" }, { type: "function", function: { name: "write", parameters: {} } }],
    })
    const result = rewriteRequestBody(body, "_r", log)
    expect(result).toBeDefined()
    const parsed = JSON.parse(result!.body) as { tools: Array<{ function: { name: string } } | null | { type: string }> }
    expect((parsed.tools[2] as { function: { name: string } }).function.name).toBe("write_r")
  })
})

describe("readRequestBody", () => {
  test("decodes string and binary bodies", async () => {
    expect(await readRequestBody("https://x", { body: '{"a":1}' })).toBe('{"a":1}')
    expect(await readRequestBody("https://x", { body: new TextEncoder().encode('{"a":1}') })).toBe('{"a":1}')
  })

  test("reads a Request passed without init", async () => {
    const req = new Request("https://x", { method: "POST", body: '{"a":1}' })
    expect(await readRequestBody(req)).toBe('{"a":1}')
  })

  test("returns undefined for stream bodies", async () => {
    const stream = new ReadableStream<Uint8Array>()
    expect(await readRequestBody("https://x", { body: stream as unknown as BodyInit })).toBeUndefined()
  })
})

describe("wrapResponseRewrite", () => {
  test("restores tool names in a JSON response and fixes content-length", async () => {
    const body = JSON.stringify({
      choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "write_r", arguments: "{}" } }] } }],
    })
    const response = new Response(body, {
      headers: { "content-type": "application/json", "content-length": String(body.length) },
    })
    const out = await wrapResponseRewrite(response, new Map([["write_r", "write"]]), log)
    const text = await out.text()
    const parsed = JSON.parse(text) as { choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }> }
    expect(parsed.choices[0].message.tool_calls[0].function.name).toBe("write")
    expect(out.headers.get("content-length")).toBe(String(new TextEncoder().encode(text).length))
  })

  test("restores tool names in an SSE stream, leaves other events intact", async () => {
    const chunk = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
    const stream = [
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "write_r" } }] } }] }),
      chunk({ choices: [{ delta: { content: "hello" } }] }),
      "data: [DONE]\n\n",
    ].join("")
    const out = await wrapResponseRewrite(
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      new Map([["write_r", "write"]]),
      log,
    )
    const text = await out.text()
    const events = text
      .split("\n")
      .filter((l) => l.startsWith("data:") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)))
    const first = events[0] as { choices: Array<{ delta: { tool_calls: Array<{ function: { name: string } }> } }> }
    expect(first.choices[0].delta.tool_calls[0].function.name).toBe("write")
    const second = events[1] as { choices: Array<{ delta: { content: string } }> }
    expect(second.choices[0].delta.content).toBe("hello")
    expect(text).toContain("data: [DONE]")
  })

  test("passes through non-JSON responses untouched", async () => {
    const response = new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain" } })
    const out = await wrapResponseRewrite(response, new Map([["write_r", "write"]]), log)
    expect(out.status).toBe(500)
    expect(await out.text()).toBe("Internal Server Error")
  })
})
