import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { pick, markRateLimited, markSuccess, markAuthFailed, allRateLimited, resetHealth, resetAllHealth, summarizeStates, status } from "../src/rotation"
import { add, invalidateCache } from "../src/storage"

const mockAccounts = [
  { id: "a", label: "primary", domain: "github.com", token: "t1", added_at: 1, priority: 0 },
  { id: "b", label: "secondary", domain: "github.com", token: "t2", added_at: 2, priority: 1 },
  { id: "c", label: "tertiary", domain: "github.com", token: "t3", added_at: 3, priority: 2 },
]

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-rot-"))
  process.env.COPILOT_MULTI_AUTH_DATA_DIR = tmpDir
  invalidateCache()
  resetHealth("a")
  resetHealth("b")
  resetHealth("c")
  for (const account of mockAccounts) await add(account)
})

afterEach(async () => {
  delete process.env.COPILOT_MULTI_AUTH_DATA_DIR
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("rotation", () => {
  test("pick returns highest priority available account", async () => {
    const result = await pick()
    expect(result?.account.id).toBe("a")
  })

  test("pick skips rate limited accounts", async () => {
    markRateLimited("a", 60_000)
    const result = await pick()
    expect(result?.account.id).toBe("b")
  })

  test("pick respects exclude set", async () => {
    const result = await pick(new Set(["a"]))
    expect(result?.account.id).toBe("b")
  })

  test("pick returns undefined when all excluded", async () => {
    const result = await pick(new Set(["a", "b", "c"]))
    expect(result).toBeUndefined()
  })

  test("markSuccess records last_success", () => {
    const before = Date.now()
    markSuccess("a")
    const h = status().get("a")
    expect(h?.last_success).toBeGreaterThanOrEqual(before)
  })

  test("markAuthFailed makes account unavailable", async () => {
    markAuthFailed("a")
    const result = await pick()
    expect(result?.account.id).toBe("b")
  })

  test("markAuthFailed skips all auth-failed accounts", async () => {
    markAuthFailed("a")
    markAuthFailed("b")
    markAuthFailed("c")
    const result = await pick()
    expect(result).toBeUndefined()
  })

  test("resetHealth clears auth_failed", async () => {
    markAuthFailed("a")
    resetHealth("a")
    const result = await pick()
    expect(result?.account.id).toBe("a")
  })

  test("allRateLimited returns earliest recovery time", async () => {
    const now = Date.now()
    markRateLimited("a", 30_000)
    markRateLimited("b", 60_000)
    markRateLimited("c", 90_000)
    const result = await allRateLimited()
    expect(typeof result).toBe("number")
    expect(result as number).toBeGreaterThanOrEqual(now + 30_000)
    expect(result as number).toBeLessThanOrEqual(now + 30_000 + 100)
  })

  test("allRateLimited returns false when account available", async () => {
    markRateLimited("a", 60_000)
    const result = await allRateLimited()
    expect(result).toBe(false)
  })

  test("pick prefers preferred account when available", async () => {
    const result = await pick(undefined, "b")
    expect(result?.account.id).toBe("b")
  })

  test("pick falls back to priority order when preferred is rate limited", async () => {
    markRateLimited("b", 60_000)
    const result = await pick(undefined, "b")
    expect(result?.account.id).toBe("a")
  })

  test("pick falls back to priority order when preferred is auth failed", async () => {
    markAuthFailed("b")
    const result = await pick(undefined, "b")
    expect(result?.account.id).toBe("a")
  })

  test("pick ignores preferred if in exclude set", async () => {
    const result = await pick(new Set(["b"]), "b")
    expect(result?.account.id).toBe("a")
  })

  test("rate limited account becomes available after expiry", async () => {
    markRateLimited("a", 1)
    await Bun.sleep(5)
    const result = await pick()
    expect(result?.account.id).toBe("a")
  })

  test("auth-failed account becomes available after TTL expiry", async () => {
    markAuthFailed("a", 1)
    await Bun.sleep(5)
    const result = await pick()
    expect(result?.account.id).toBe("a")
  })

  test("allRateLimited ignores auth-failed accounts for earliest calc", async () => {
    const now = Date.now()
    markAuthFailed("a")
    markRateLimited("b", 60_000)
    markRateLimited("c", 90_000)
    const result = await allRateLimited()
    expect(typeof result).toBe("number")
    expect(result as number).toBeGreaterThanOrEqual(now + 60_000)
    expect(result as number).toBeLessThanOrEqual(now + 60_000 + 100)
  })

  test("allRateLimited returns false when all accounts are only auth-failed", async () => {
    markAuthFailed("a")
    markAuthFailed("b")
    markAuthFailed("c")
    const result = await allRateLimited()
    expect(result).toBe(false)
  })

  test("summarizeStates returns per-account reasons", async () => {
    markRateLimited("a", 60_000)
    markAuthFailed("b")
    const states = await summarizeStates()
    expect(states).toHaveLength(3)
    const byId = new Map(states.map(s => [s.id, s]))
    expect(byId.get("a")?.reason).toBe("rate_limited")
    expect(byId.get("a")?.until).toBeGreaterThan(Date.now())
    expect(byId.get("b")?.reason).toBe("auth_failed")
    expect(byId.get("b")?.until).toBeGreaterThan(Date.now())
    expect(byId.get("c")?.reason).toBe("available")
  })

  test("summarizeStates reports available once rate-limit window expires", async () => {
    markRateLimited("a", 1)
    await Bun.sleep(5)
    const states = await summarizeStates()
    const a = states.find(s => s.id === "a")
    expect(a?.reason).toBe("available")
  })

  test("resetAllHealth clears state for every account", async () => {
    markRateLimited("a", 60_000)
    markAuthFailed("b")
    resetAllHealth()
    const states = await summarizeStates()
    expect(states.every(s => s.reason === "available")).toBe(true)
  })
})
