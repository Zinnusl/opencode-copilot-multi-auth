import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { createFetch } from "../src/fetch"
import { resetHealth } from "../src/rotation"
import { add, invalidateCache } from "../src/storage"

const mockAccounts = [
  { id: "a", label: "primary", domain: "github.com", token: "token-a", added_at: 1, priority: 0 },
  { id: "b", label: "secondary", domain: "github.com", token: "token-b", added_at: 2, priority: 1 },
]

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-fetch-"))
  process.env.COPILOT_MULTI_AUTH_DATA_DIR = tmpDir
  invalidateCache()
  resetHealth("a")
  resetHealth("b")
  for (const account of mockAccounts) await add(account)
})

afterEach(async () => {
  delete process.env.COPILOT_MULTI_AUTH_DATA_DIR
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("fetch wrapper", () => {
  test("uses primary account token in Authorization header", async () => {
    let capturedHeaders: Record<string, string> = {}
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_req: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      })
      expect(capturedHeaders["Authorization"]).toBe("Bearer token-a")
      expect(capturedHeaders["User-Agent"]).toBe("opencode/0.1.0")
      expect(capturedHeaders["Openai-Intent"]).toBe("conversation-edits")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("retries with next account on 429", async () => {
    const tokens: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_req: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      tokens.push(headers["Authorization"])
      if (tokens.length === 1) {
        return new Response("", { status: 429, headers: { "Retry-After": "60" } })
      }
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      const response = await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      })
      expect(response.status).toBe(200)
      expect(tokens).toEqual(["Bearer token-a", "Bearer token-b"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("returns 429 with recovery time when all accounts rate limited", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      return new Response("", { status: 429, headers: { "Retry-After": "60" } })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      const response = await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      })
      expect(response.status).toBe(429)
      const body = await response.json() as { error: string }
      expect(body.error).toContain("rate limited")
      expect(body.error).toContain("earliest recovery")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("retries with next account on 401", async () => {
    const tokens: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_req: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      tokens.push(headers["Authorization"])
      if (tokens.length === 1) {
        return new Response("Unauthorized", { status: 401 })
      }
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      const response = await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      })
      expect(response.status).toBe(200)
      expect(tokens).toEqual(["Bearer token-a", "Bearer token-b"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("returns 401 when all accounts auth-failed", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      return new Response("Unauthorized", { status: 401 })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      const response = await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      })
      expect(response.status).toBe(401)
      const body = await response.json() as { error: string }
      expect(body.error).toContain("auth-failed")
      expect(body.error).not.toContain("rate limited")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("mixed rate-limited + auth-failed reports both accurately", async () => {
    const originalFetch = globalThis.fetch
    let callCount = 0
    globalThis.fetch = (async () => {
      callCount++
      if (callCount === 1) return new Response("", { status: 429, headers: { "Retry-After": "60" } })
      return new Response("Unauthorized", { status: 401 })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      const response = await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      })
      expect(response.status).toBe(429)
      const body = await response.json() as { error: string }
      expect(body.error).toContain("1 rate limited")
      expect(body.error).toContain("1 auth-failed")
      expect(body.error).toContain("earliest recovery")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("sticks to same account for same session", async () => {
    const tokens: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_req: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      tokens.push(headers["Authorization"])
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        headers: { "x-opencode-session": "session-1" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      })
      await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        headers: { "x-opencode-session": "session-1" },
        body: JSON.stringify({ messages: [{ role: "user", content: "world" }] }),
      })
      expect(tokens).toEqual(["Bearer token-a", "Bearer token-a"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("different sessions can use different accounts if first is rate limited", async () => {
    const tokens: string[] = []
    const originalFetch = globalThis.fetch
    let callCount = 0
    globalThis.fetch = (async (_req: RequestInfo | URL, init?: RequestInit) => {
      callCount++
      const headers = init?.headers as Record<string, string>
      tokens.push(headers["Authorization"])
      if (callCount === 1) {
        return new Response("", { status: 429, headers: { "Retry-After": "60" } })
      }
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        headers: { "x-opencode-session": "session-1" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      })
      await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        headers: { "x-opencode-session": "session-1" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hello again" }] }),
      })
      expect(tokens).toEqual(["Bearer token-a", "Bearer token-b", "Bearer token-b"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("strips previous_response_id from body on account failover", async () => {
    const bodies: string[] = []
    const originalFetch = globalThis.fetch
    let callCount = 0
    globalThis.fetch = (async (_req: RequestInfo | URL, init?: RequestInit) => {
      callCount++
      bodies.push(init?.body as string)
      if (callCount === 1) {
        return new Response("", { status: 429, headers: { "Retry-After": "60" } })
      }
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        headers: { "x-opencode-session": "session-1" },
        body: JSON.stringify({
          model: "gpt-4",
          input: [{ role: "user", content: "hello" }],
          previous_response_id: "resp_abc123",
        }),
      })
      const body1 = JSON.parse(bodies[0])
      expect(body1.previous_response_id).toBe("resp_abc123")
      const body2 = JSON.parse(bodies[1])
      expect(body2.previous_response_id).toBeUndefined()
      expect(body2.input).toEqual([{ role: "user", content: "hello" }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("once a session has switched accounts, keeps stripping IDs on subsequent requests", async () => {
    const bodies: string[] = []
    const originalFetch = globalThis.fetch
    let callCount = 0
    globalThis.fetch = (async (_req: RequestInfo | URL, init?: RequestInit) => {
      callCount++
      bodies.push(init?.body as string)
      // First call: 429 on account a
      if (callCount === 1) return new Response("", { status: 429, headers: { "Retry-After": "60" } })
      // Otherwise: succeed
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      // Turn 1: a rate-limited, failover to b. b should receive stripped body.
      await copilotFetch("https://api.githubcopilot.com/responses", {
        method: "POST",
        headers: { "x-opencode-session": "session-1" },
        body: JSON.stringify({
          model: "gpt-5",
          input: [{ id: "msg_old", role: "user", content: "hi" }],
          previous_response_id: "resp_old",
        }),
      })
      // Turn 2: same session, preferred stays b. But body still carries old IDs from prior account.
      await copilotFetch("https://api.githubcopilot.com/responses", {
        method: "POST",
        headers: { "x-opencode-session": "session-1" },
        body: JSON.stringify({
          model: "gpt-5",
          input: [{ id: "msg_still_old", role: "user", content: "hi2" }],
          previous_response_id: "resp_still_old",
        }),
      })
      // bodies[0] = original (a attempt), bodies[1] = stripped (b failover), bodies[2] = stripped (b turn 2)
      expect(callCount).toBe(3)
      const turn2 = JSON.parse(bodies[2])
      expect(turn2.previous_response_id).toBeUndefined()
      expect(turn2.input[0].id).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("strips id fields from input items on account failover", async () => {
    const bodies: string[] = []
    const originalFetch = globalThis.fetch
    let callCount = 0
    globalThis.fetch = (async (_req: RequestInfo | URL, init?: RequestInit) => {
      callCount++
      bodies.push(init?.body as string)
      if (callCount === 1) {
        return new Response("", { status: 429, headers: { "Retry-After": "60" } })
      }
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      await copilotFetch("https://api.githubcopilot.com/responses", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-5",
          input: [
            { role: "user", content: "hello" },
            { id: "fc_abc123", type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
            { id: "fco_xyz789", type: "function_call_output", call_id: "c1", output: "ok" },
          ],
        }),
      })
      const body1 = JSON.parse(bodies[0])
      expect(body1.input[1].id).toBe("fc_abc123")
      const body2 = JSON.parse(bodies[1])
      expect(body2.input[0].id).toBeUndefined()
      expect(body2.input[1].id).toBeUndefined()
      expect(body2.input[1].type).toBe("function_call")
      expect(body2.input[2].id).toBeUndefined()
      expect(body2.input[2].type).toBe("function_call_output")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("keeps previous_response_id when retrying with same account preference", async () => {
    const bodies: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_req: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(init?.body as string)
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4",
          input: [{ role: "user", content: "hello" }],
          previous_response_id: "resp_abc123",
        }),
      })
      const body1 = JSON.parse(bodies[0])
      expect(body1.previous_response_id).toBe("resp_abc123")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("strips x-opencode-session header before sending to API", async () => {
    let capturedHeaders: Record<string, string> = {}
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_req: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        headers: { "x-opencode-session": "session-1" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      })
      expect(capturedHeaders["x-opencode-session"]).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("retries with next account on 5xx", async () => {
    const tokens: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_req: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      tokens.push(headers["Authorization"])
      if (tokens.length === 1) {
        return new Response("Bad Gateway", { status: 502 })
      }
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      const response = await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      })
      expect(response.status).toBe(200)
      expect(tokens).toEqual(["Bearer token-a", "Bearer token-b"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("returns last 5xx when all accounts fail with 5xx", async () => {
    const originalFetch = globalThis.fetch
    let callCount = 0
    globalThis.fetch = (async () => {
      callCount++
      return new Response("Service Unavailable", { status: 503 })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      const response = await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      })
      expect(response.status).toBe(503)
      expect(callCount).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("retries with next account on network error", async () => {
    const tokens: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_req: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      tokens.push(headers["Authorization"])
      if (tokens.length === 1) {
        throw new Error("ECONNRESET")
      }
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      const response = await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      })
      expect(response.status).toBe(200)
      expect(tokens).toEqual(["Bearer token-a", "Bearer token-b"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("propagates network error when all accounts fail to connect", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error("ECONNRESET")
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      await expect(
        copilotFetch("https://api.githubcopilot.com/chat/completions", {
          method: "POST",
          body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
        })
      ).rejects.toThrow("ECONNRESET")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("removes x-api-key and lowercase authorization headers", async () => {
    let capturedHeaders: Record<string, string> = {}
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_req: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    try {
      const copilotFetch = createFetch("0.1.0")
      await copilotFetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        headers: { "x-api-key": "should-be-removed", authorization: "should-be-removed" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      })
      expect(capturedHeaders["x-api-key"]).toBeUndefined()
      expect(capturedHeaders["authorization"]).toBeUndefined()
      expect(capturedHeaders["Authorization"]).toBe("Bearer token-a")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
