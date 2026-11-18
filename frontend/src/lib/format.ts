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

function formatMoney(value: number, currency: string, notation: 'standard' | 'compact') {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      notation,
      maximumFractionDigits: 2,
    }).format(value)
  } catch {
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${currency}`
  }
}

export function fmtMoney(value: number, currency = orgCurrency): string {
  return formatMoney(value, currency, 'standard')
}

export function fmtMoneyShort(value: number, currency?: string): string {
  return formatMoney(value, currency ?? orgCurrency, 'compact')
}

export function useMoneyFormatter() {
  const currency = useOrgCurrency()
  return (value: number, sourceCurrency = currency) => fmtMoney(value, sourceCurrency)
}
