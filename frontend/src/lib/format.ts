import { useSyncExternalStore } from 'react'

/**
 * Currency-aware money formatting (product gap D2).
 * Defaults to the org currency; falls back to USD.
 */

let orgCurrency = 'USD'
const listeners = new Set<() => void>()

export function setOrgCurrency(currency: string) {
  const next = currency || 'USD'
  if (orgCurrency === next) return
  orgCurrency = next
  listeners.forEach((listener) => listener())
}

export function getOrgCurrency() {
  return orgCurrency
}

export function useOrgCurrency() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, getOrgCurrency, getOrgCurrency)
}

/** Format a number as money in the org currency. */
export function fmtMoney(value: number, currency?: string): string {
  const cur = currency ?? orgCurrency
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: cur,
      maximumFractionDigits: 2,
    }).format(value)
  } catch {
    return `$${value.toFixed(2)}`
  }
}

/** Short form for charts (e.g. $1.2K, ¥3.4万). */
export function fmtMoneyShort(value: number, currency?: string): string {
  const cur = currency ?? orgCurrency
  const abs = Math.abs(value)
  const symbol =
    cur === 'CNY' ? '¥' : cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : '$'
  if (abs >= 1_000_000) return `${symbol}${(value / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${symbol}${(value / 1_000).toFixed(1)}K`
  return `${symbol}${value.toFixed(2)}`
}
