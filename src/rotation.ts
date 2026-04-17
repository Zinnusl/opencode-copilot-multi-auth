import {
  AUTH_FAIL_TTL_MS,
  DEFAULT_RETRY_AFTER_MS,
  MAX_RETRY_AFTER_MS,
  type AccountHealth,
  type RotationResult,
} from "./types"
import { list } from "./storage"

const health = new Map<string, AccountHealth>()

function getHealth(id: string): AccountHealth {
  const existing = health.get(id)
  if (existing) return existing
  const fresh: AccountHealth = {
    id,
    rate_limited_until: 0,
    auth_failed_until: 0,
    last_success: 0,
    last_failure: 0,
  }
  health.set(id, fresh)
  return fresh
}


function isAvailable(h: AccountHealth): boolean {
  const now = Date.now()
  if (h.auth_failed_until > 0) {
    if (now < h.auth_failed_until) return false
    h.auth_failed_until = 0
  }
  if (h.rate_limited_until > 0) {
    if (now < h.rate_limited_until) return false
    h.rate_limited_until = 0
  }
  return true
}

export async function pick(excludeIds?: Set<string>, preferredId?: string): Promise<RotationResult> {
  const accounts = await list()
  if (preferredId && !excludeIds?.has(preferredId)) {
    const preferred = accounts.find(a => a.id === preferredId)
    if (preferred) {
      const h = getHealth(preferred.id)
      if (isAvailable(h)) return { account: preferred, health: h }
    }
  }
  for (const account of accounts) {
    if (excludeIds?.has(account.id)) continue
    const h = getHealth(account.id)
    if (isAvailable(h)) return { account, health: h }
  }
  return undefined
}

export function markRateLimited(id: string, retryAfterMs?: number) {
  const h = getHealth(id)
  const delay = Math.min(retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS)
  h.rate_limited_until = Date.now() + delay
  h.last_failure = Date.now()
}

export function markSuccess(id: string) {
  const h = getHealth(id)
  h.last_success = Date.now()
}

export function markAuthFailed(id: string, ttlMs: number = AUTH_FAIL_TTL_MS) {
  const h = getHealth(id)
  h.auth_failed_until = Date.now() + ttlMs
  h.last_failure = Date.now()
}

export async function allRateLimited(): Promise<number | false> {
  const accounts = await list()
  if (accounts.length === 0) return false
  let earliest = Infinity
  for (const account of accounts) {
    const h = getHealth(account.id)
    if (isAvailable(h)) return false
    if (h.rate_limited_until > 0 && h.rate_limited_until < earliest) {
      earliest = h.rate_limited_until
    }
  }
  return earliest === Infinity ? false : earliest
}

export type AccountStateReason = "available" | "rate_limited" | "auth_failed"

export type AccountState = {
  id: string
  label: string
  reason: AccountStateReason
  until: number
}

export async function summarizeStates(): Promise<AccountState[]> {
  const accounts = await list()
  const now = Date.now()
  return accounts.map((a) => {
    const h = health.get(a.id)
    if (!h) return { id: a.id, label: a.label, reason: "available" as const, until: 0 }
    if (h.rate_limited_until > now) {
      return { id: a.id, label: a.label, reason: "rate_limited" as const, until: h.rate_limited_until }
    }
    if (h.auth_failed_until > now) {
      return { id: a.id, label: a.label, reason: "auth_failed" as const, until: h.auth_failed_until }
    }
    return { id: a.id, label: a.label, reason: "available" as const, until: 0 }
  })
}

export function status(): Map<string, AccountHealth> {
  return new Map(health)
}

export function resetHealth(id: string) {
  health.delete(id)
}

export function resetAllHealth() {
  health.clear()
}

export function hasBeenUsed(id: string): boolean {
  return health.has(id)
}
