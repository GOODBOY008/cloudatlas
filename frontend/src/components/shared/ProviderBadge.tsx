import { providerLabel } from '../../lib/providers'

const COLORS: Record<string, string> = {
  aws: 'bg-orange-900/40 text-orange-300',
  alibaba: 'bg-yellow-900/40 text-yellow-300',
  azure: 'bg-blue-900/40 text-blue-300',
  gcp: 'bg-red-900/40 text-red-300',
  kubernetes: 'bg-indigo-900/40 text-indigo-300',
}

export function ProviderBadge({ provider }: { provider: string | null | undefined }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${COLORS[provider ?? ''] ?? 'bg-gray-700 text-gray-400'}`}>
      {providerLabel(provider)}
    </span>
  )
}