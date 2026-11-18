/** Billing endpoints use inclusive UTC calendar dates. */
export function billingDateRange(days: number | null, now = new Date()) {
  const endDate = now.toISOString().slice(0, 10)
  const startDate = days === null
    ? `${endDate.slice(0, 7)}-01`
    : new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  return { startDate, endDate }
}
