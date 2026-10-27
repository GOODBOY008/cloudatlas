import { providerLabel } from '../../lib/providers'

const COLORS: Record<string, string> = {
  aws: 'bg-warning/10 text-warning',
  alibaba: 'bg-warning/10 text-warning',
  azure: 'bg-info/10 text-info',
  gcp: 'bg-danger/10 text-danger',
  kubernetes: 'bg-accent-soft/40 text-accent',
}

export function ProviderBadge({ provider }: { provider: string | null | undefined }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${COLORS[provider ?? ''] ?? 'bg-emphasis text-secondary'}`}>
      {providerLabel(provider)}
    </span>
  )
}