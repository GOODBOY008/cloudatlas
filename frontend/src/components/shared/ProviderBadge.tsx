import { Badge, type BadgeVariant } from '@cloudflare/kumo/components/badge'
import { providerLabel } from '../../lib/providers'

const variants: Record<string, BadgeVariant> = {
  aws: 'warning',
  alibaba: 'warning',
  azure: 'info',
  gcp: 'red',
  kubernetes: 'info',
}

export function ProviderBadge({ provider }: { provider: string | null | undefined }) {
  return <Badge variant={variants[provider ?? ''] ?? 'secondary'}>{providerLabel(provider)}</Badge>
}
