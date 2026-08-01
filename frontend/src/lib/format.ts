/**
 * Currency-aware money formatting (product gap D2).
 * Defaults to the org currency; falls back to USD.
 */

let orgCurrency = 'USD'

export function setOrgCurrency(currency: string) {
  orgCurrency = currency || 'USD'
}

export function getOrgCurrency() {
  return orgCurrency
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
