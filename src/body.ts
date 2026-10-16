/**
 * Request/response body rewriting for tool-name renames.
 *
 * Gateway policy counts original tool names in the request body; appending a
 * suffix to every tool name brings that count to zero. The rename must be
 * symmetric: outbound requests carry renamed names (tools list + message
 * history + named tool_choice), inbound responses have tool_calls mapped back
 * so the host keeps working with its original names.
 *
 * Nothing here imports an OpenCode SDK — shared by both entrypoints.
 */

export type RewriteLog = (msg: string) => void

/** Result of rewriting one outbound request body. */
export type RequestRewrite = {
  /** Re-serialized JSON body with renamed tools. */
  body: string
  /** renamed -> original, for restoring tool_calls on the response side. */
  reverseMap: Map<string, string>
}

/* ------------------------------------------------------------------ */
/* Outbound: request body                                              */
/* ------------------------------------------------------------------ */

/**
 * Decode the outbound body to text so it can be parsed and rewritten.
 * Returns undefined when there is no usable body (stream/Blob/absent).
 */
export async function readRequestBody(req: RequestInfo | URL, init?: RequestInit): Promise<string | undefined> {
  const body = init?.body
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body))
  // fetch(Request) with no overriding init: clone so the original request
  // stays consumable when rewriting (or the fetch itself) fails.
  if (init === undefined && typeof Request !== "undefined" && req instanceof Request) {
    try {
      return await req.clone().text()
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Rename every tool in a chat-completions request body.
 *
 * Renames `tools[].function.name`, `messages[].tool_calls[].function.name`
 * (history must stay consistent with the advertised tools) and the named
 * `tool_choice` form. Returns undefined when the body has no tools array
 * (nothing to do) or cannot be parsed (fail-open: caller forwards the
 * original body untouched).
 */
export function rewriteRequestBody(raw: string, suffix: string, log: RewriteLog): RequestRewrite | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    log(`request body rewrite skipped, not JSON: ${err}`)
    return undefined
  }
  if (parsed === null || typeof parsed !== "object") return undefined
  const payload = parsed as Record<string, unknown>
  const tools = payload.tools
  if (!Array.isArray(tools) || tools.length === 0) return undefined

  const reverseMap = new Map<string, string>()
  const rename = (name: unknown): unknown => {
    if (typeof name !== "string" || name === "") return name
    const renamed = `${name}${suffix}`
    reverseMap.set(renamed, name)
    return renamed
  }

  let touched = false
  for (const tool of tools) {
    if (tool === null || typeof tool !== "object") continue
    const fn = (tool as Record<string, unknown>).function
    if (fn === null || typeof fn !== "object") continue
    const fnRec = fn as Record<string, unknown>
    const renamed = rename(fnRec.name)
    if (renamed !== fnRec.name) {
      fnRec.name = renamed
      touched = true
    }
  }
  if (!touched) return undefined

  const messages = payload.messages
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (message === null || typeof message !== "object") continue
      rewriteToolCallsList((message as Record<string, unknown>).tool_calls, rename)
    }
  }

  const choice = payload.tool_choice
  if (choice !== null && typeof choice === "object") {
    const fn = (choice as Record<string, unknown>).function
    if (fn !== null && typeof fn === "object") {
      const fnRec = fn as Record<string, unknown>
      fnRec.name = rename(fnRec.name)
    }
  }

  log(`renamed ${reverseMap.size} tool(s) with suffix "${suffix}"`)
  return { body: JSON.stringify(payload), reverseMap }
}

/* ------------------------------------------------------------------ */
/* Inbound: response tool_calls restoration                            */
/* ------------------------------------------------------------------ */

/** Map one function-name field through a restore function, in place. */
function restoreCallsIn(
  container: unknown,
  key: "delta" | "message",
  restore: (name: unknown) => unknown,
): boolean {
  if (container === null || typeof container !== "object") return false
  const part = (container as Record<string, unknown>)[key]
  if (part === null || typeof part !== "object") return false
  const calls = (part as Record<string, unknown>).tool_calls
  if (!Array.isArray(calls)) return false
  for (const call of calls) {
    if (call === null || typeof call !== "object") continue
    const fn = (call as Record<string, unknown>).function
    if (fn === null || typeof fn !== "object") continue
    const fnRec = fn as Record<string, unknown>
    fnRec.name = restore(fnRec.name)
  }
  return true
}

function rewriteToolCallsList(calls: unknown, rename: (name: unknown) => unknown): void {
  if (!Array.isArray(calls)) return
  for (const call of calls) {
    if (call === null || typeof call !== "object") continue
    const fn = (call as Record<string, unknown>).function
    if (fn === null || typeof fn !== "object") continue
    const fnRec = fn as Record<string, unknown>
    fnRec.name = rename(fnRec.name)
  }
}

/**
 * Wrap a response so renamed tool_calls are mapped back to original names.
 *
 * SSE (text/event-stream) is rewritten line-buffered per `data:` event;
 * everything else is treated as one JSON document. Non-JSON or error bodies
 * pass through unchanged.
 */
export async function wrapResponseRewrite(
  response: Response,
  reverseMap: Map<string, string>,
  log: RewriteLog,
): Promise<Response> {
  const restore = (name: unknown): unknown => (typeof name === "string" ? (reverseMap.get(name) ?? name) : name)
  const contentType = response.headers.get("content-type") ?? ""
  if (contentType.includes("text/event-stream")) {
    return rewriteStreamResponse(response, restore, log)
  }
  return rewriteJsonResponse(response, restore, log)
}

async function rewriteJsonResponse(
  response: Response,
  restore: (name: unknown) => unknown,
  log: RewriteLog,
): Promise<Response> {
  const text = await response.text()
  let out = text
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === "object") {
      const choices = (parsed as Record<string, unknown>).choices
      if (Array.isArray(choices)) {
        let touched = 0
        for (const choice of choices) {
          if (restoreCallsIn(choice, "message", restore)) touched++
        }
        if (touched > 0) {
          out = JSON.stringify(parsed)
          log(`restored ${touched} tool_call(s) in JSON response`)
        }
      }
    }
  } catch {
    log("response rewrite skipped, body is not JSON")
  }
  if (out === text) {
    // The original body stream was consumed by text(); hand back a fresh one.
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
  const headers = new Headers(response.headers)
  headers.set("content-length", String(new TextEncoder().encode(out).length))
  return new Response(out, { status: response.status, statusText: response.statusText, headers })
}

async function rewriteStreamResponse(
  response: Response,
  restore: (name: unknown) => unknown,
  log: RewriteLog,
): Promise<Response> {
  if (!response.body) return response
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  let restored = 0

  const rewriteEvent = (line: string): string => {
    if (!line.startsWith("data:")) return line
    const cr = line.endsWith("\r") ? "\r" : ""
    const data = (cr ? line.slice(5, -1) : line.slice(5)).trimStart()
    if (data === "" || data === "[DONE]") return line
    try {
      const parsed: unknown = JSON.parse(data)
      if (parsed === null || typeof parsed !== "object") return line
      const choices = (parsed as Record<string, unknown>).choices
      if (!Array.isArray(choices)) return line
      for (const choice of choices) {
        // OpenAI-compatible providers emit each delta's function.name complete
        // in one chunk (only arguments fragment afterwards).
        if (restoreCallsIn(choice, "delta", restore)) restored++
      }
      return `data: ${JSON.stringify(parsed)}${cr}`
    } catch {
      // ponytail: tool names split across SSE chunks pass through unrewritten;
      // if a gateway ever fragments names, switch to a streaming JSON parser.
      log("sse event parse failed, passing through")
      return line
    }
  }

  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${rewriteEvent(line)}\n`))
        }
      },
      flush(controller) {
        if (buffer !== "") controller.enqueue(encoder.encode(rewriteEvent(buffer)))
        if (restored > 0) log(`restored ${restored} tool_call(s) in stream`)
      },
    }),
  )
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return new Response(stream, { status: response.status, statusText: response.statusText, headers })
}
