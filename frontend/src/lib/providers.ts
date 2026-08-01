import i18n from '../i18n'

/**
 * Canonical ordered list of cloud provider slugs offered in account/CI forms.
 * Display names live in the `providers.*` i18n keys — always render a provider
 * through `providerLabel()` so every page shows identical names.
 */
export const CLOUD_PROVIDERS = ['aws', 'alibaba', 'azure', 'gcp', 'kubernetes', 'other'] as const

/**
 * Canonical display name for a cloud provider slug (e.g. `alibaba` → "Alibaba Cloud").
 * Unknown slugs fall back to the raw value; null/empty renders an em dash.
 */
export function providerLabel(provider: string | null | undefined): string {
  if (!provider) return '—'
  return i18n.t(`providers.${provider}`, { defaultValue: provider })
}