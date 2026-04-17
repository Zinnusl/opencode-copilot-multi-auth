import type { Account } from "./types"
import { MAX_SESSION_ENTRIES } from "./types"
import {
  pick,
  markRateLimited,
  markSuccess,
  markAuthFailed,
  summarizeStates,
  type AccountState,
} from "./rotation"

function buildUnavailableError(states: AccountState[]): { status: number; error: string } {
  const rateLimited = states.filter((s) => s.reason === "rate_limited")
  const authFailed = states.filter((s) => s.reason === "auth_failed")

  if (states.length === 0) {
    return { status: 401, error: "No GitHub Copilot accounts configured" }
  }

  const parts: string[] = []
  if (rateLimited.length > 0) {
    const earliest = rateLimited.reduce((min, s) => (s.until < min ? s.until : min), Infinity)
    const names = rateLimited.map((s) => s.label).join(", ")
    parts.push(`${rateLimited.length} rate limited (${names}; earliest recovery: ${new Date(earliest).toISOString()})`)
  }
  if (authFailed.length > 0) {
    const names = authFailed.map((s) => s.label).join(", ")
    parts.push(`${authFailed.length} auth-failed (${names}; re-authenticate or run /copilot-accounts reset)`)
  }

  const status = authFailed.length > 0 && rateLimited.length === 0 ? 401 : 429
  return { status, error: `No Copilot accounts available. ${parts.join("; ")}` }
}

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after")
  if (!header) return undefined
  const seconds = Number(header)
  if (!Number.isNaN(seconds)) return seconds * 1000
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

function detectVision(body: unknown): boolean {
  if (!body || typeof body !== "object") return false
  const b = body as Record<string, unknown>

  if (Array.isArray(b.messages)) {
    return b.messages.some(
      (msg: Record<string, unknown>) =>
        Array.isArray(msg.content) &&
        (msg.content as Record<string, unknown>[]).some(
          (part) => part.type === "image_url" || part.type === "image"
        )
    )
  }

  if (Array.isArray(b.input)) {
    return (b.input as Record<string, unknown>[]).some(
      (item) =>
        Array.isArray(item.content) &&
        (item.content as Record<string, unknown>[]).some(
          (part) => part.type === "input_image"
        )
    )
  }

  return false
}

function detectAgent(body: unknown, url: string): boolean {
  if (!body || typeof body !== "object") return false
  const b = body as Record<string, unknown>

  if (Array.isArray(b.messages) && url.includes("completions")) {
    const last = (b.messages as Record<string, unknown>[])[b.messages.length - 1]
    return last?.role !== "user"
  }

  if (Array.isArray(b.input)) {
    const last = (b.input as Record<string, unknown>[])[b.input.length - 1]
    return last?.role !== "user"
  }

  if (Array.isArray(b.messages)) {
    const last = (b.messages as Record<string, unknown>[])[b.messages.length - 1]
    const hasNonToolCalls =
      Array.isArray(last?.content) &&
      (last.content as Record<string, unknown>[]).some((part) => part.type !== "tool_result")
    return !(last?.role === "user" && hasNonToolCalls)
  }

  return false
}

import fs from "fs"
import path from "path"
import os from "os"

const DEBUG = process.env.COPILOT_MULTI_AUTH_DEBUG === "1"
const LOG_PATH = process.env.COPILOT_MULTI_AUTH_LOG ?? path.join(os.homedir(), ".local", "share", "opencode", "copilot-multi-auth.log")

function debugLog(...args: unknown[]) {
  if (!DEBUG) return
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`
  try { fs.appendFileSync(LOG_PATH, line) } catch {}
}

function buildHeaders(account: Account, body: unknown, url: string, version: string, init?: RequestInit): Record<string, string> {
  const isVision = detectVision(body)
  const isAgent = detectAgent(body, url)

  const headers: Record<string, string> = {
    "x-initiator": isAgent ? "agent" : "user",
    ...(init?.headers as Record<string, string>),
    "User-Agent": `opencode/${version}`,
    Authorization: `Bearer ${account.token}`,
    "Openai-Intent": "conversation-edits",
  }

  if (isVision) headers["Copilot-Vision-Request"] = "true"
  delete headers["x-api-key"]
  delete headers["authorization"]

  return headers
}

function parseBody(init?: RequestInit): unknown {
  if (!init?.body || typeof init.body !== "string") return undefined
  try { return JSON.parse(init.body) } catch { return undefined }
}

function stripResponseRef(init?: RequestInit): RequestInit | undefined {
  if (!init?.body || typeof init.body !== "string") return init
  try {
    const body = JSON.parse(init.body)
    if (!body || typeof body !== "object") return init
    let changed = false
    const next: Record<string, unknown> = { ...body }
    if ("previous_response_id" in next) {
      delete next.previous_response_id
      changed = true
    }
    if (Array.isArray(next.input)) {
      const cleaned = (next.input as Record<string, unknown>[]).map((item) => {
        if (item && typeof item === "object" && "id" in item) {
          const { id, ...rest } = item
          changed = true
          return rest
        }
        return item
      })
      next.input = cleaned
    }
    return changed ? { ...init, body: JSON.stringify(next) } : init
  } catch {}
  return init
}

export function createFetch(version: string) {
  const sessionAccounts = new Map<string, string>()
  const sessionsThatSwitched = new Set<string>()

  function rememberSession(sessionId: string, accountId: string) {
    if (sessionAccounts.has(sessionId)) {
      sessionAccounts.delete(sessionId)
    } else if (sessionAccounts.size >= MAX_SESSION_ENTRIES) {
      const firstKey = sessionAccounts.keys().next().value
      if (firstKey !== undefined) {
        sessionAccounts.delete(firstKey)
        sessionsThatSwitched.delete(firstKey)
      }
    }
    sessionAccounts.set(sessionId, accountId)
  }

  return async function copilotFetch(request: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = request instanceof URL ? request.href : request.toString()
    const body = parseBody(init)
    const tried = new Set<string>()

    const sessionId = (init?.headers as Record<string, string> | undefined)?.["x-opencode-session"]
    const preferredId = sessionId ? sessionAccounts.get(sessionId) : undefined

    let current = await pick(undefined, preferredId)
    if (!current) {
      const states = await summarizeStates()
      const { status, error } = buildUnavailableError(states)
      return new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } })
    }

    let switchedAccount = sessionId !== undefined && sessionsThatSwitched.has(sessionId)
    let lastServerError: Response | undefined
    let lastNetworkError: unknown

    while (current) {
      tried.add(current.account.id)
      const effectiveInit = switchedAccount ? stripResponseRef(init) : init
      const effectiveBody = switchedAccount ? parseBody(effectiveInit) : body
      const headers = buildHeaders(current.account, effectiveBody, url, version, effectiveInit)
      delete headers["x-opencode-session"]

      debugLog(`attempt account=${current.account.label} url=${url} headers=${JSON.stringify(Object.keys(headers))}`)

      let response: Response
      try {
        response = await fetch(request, { ...effectiveInit, headers })
      } catch (err) {
        debugLog(`network error account=${current.account.label} err=${err}`)
        lastNetworkError = err
        switchedAccount = true
        if (sessionId) sessionsThatSwitched.add(sessionId)
        current = await pick(tried, preferredId)
        continue
      }

      if (response.status === 401) {
        const bodyText = await response.clone().text().catch(() => "")
        const reqBodyStr = typeof effectiveInit?.body === "string" ? effectiveInit.body : ""
        let reqSummary = ""
        try {
          const parsed = JSON.parse(reqBodyStr)
          const prev = parsed.previous_response_id
          const inputIds: string[] = []
          if (Array.isArray(parsed.input)) {
            for (const item of parsed.input as Array<Record<string, unknown>>) {
              if (item && typeof item === "object" && typeof item.id === "string") inputIds.push(item.id)
            }
          }
          reqSummary = ` previous_response_id=${prev ?? "-"} inputIds=${JSON.stringify(inputIds)}`
        } catch {}
        debugLog(`401 account=${current.account.label}${reqSummary} body=${bodyText.slice(0, 500)}`)
        markAuthFailed(current.account.id)
        switchedAccount = true
        if (sessionId) sessionsThatSwitched.add(sessionId)
        current = await pick(tried, preferredId)
        continue
      }

      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response)
        const bodyText = await response.clone().text().catch(() => "")
        debugLog(`429 account=${current.account.label} retryAfter=${retryAfter} body=${bodyText.slice(0, 300)}`)
        markRateLimited(current.account.id, retryAfter)
        switchedAccount = true
        if (sessionId) sessionsThatSwitched.add(sessionId)
        current = await pick(tried, preferredId)
        continue
      }

      if (response.status >= 500 && response.status < 600) {
        debugLog(`5xx account=${current.account.label} status=${response.status}`)
        lastServerError = response
        switchedAccount = true
        if (sessionId) sessionsThatSwitched.add(sessionId)
        current = await pick(tried, preferredId)
        continue
      }

      debugLog(`success account=${current.account.label} status=${response.status}`)
      markSuccess(current.account.id)
      if (sessionId) rememberSession(sessionId, current.account.id)
      return response
    }

    if (lastServerError) return lastServerError
    if (lastNetworkError) throw lastNetworkError

    const states = await summarizeStates()
    const { status, error } = buildUnavailableError(states)
    return new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } })
  }
}
