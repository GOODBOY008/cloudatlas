import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'

const ENGINE_MODULES = [
  'abandoned_volume',
  'abandoned_snapshot',
  'abandoned_ip',
  'abandoned_lb',
  'abandoned_instance',
  'abandoned_image',
  'abandoned_kinesis_stream',
  'instance_for_shutdown',
  'instance_in_stopped_state',
  'rightsizing_instance',
  'rightsizing_rds',
  'instance_generation_upgrade',
  'obsolete_snapshot_chain',
  'snapshot_with_non_used_image',
  'inactive_iam_user',
  'inactive_user',
  'inactive_console_user',
  'insecure_security_group',
  's3_public_bucket',
  'reserved_instance',
  'savings_plan_opportunity',
  'instance_subscription',
  'short_living_instance',
]

interface ChecklistStatus {
  run_status: string
  last_run_at: string | null
  last_completed_at: string | null
  last_error: string | null
  modules_config: Record<string, Record<string, unknown>>
  recommendation_counts: { active: number; dismissed: number }
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-xl font-semibold text-white mt-1">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
  )
}

function RunBadge({ status }: { status: string }) {
  const { t } = useTranslation()
  const cls =
    status === 'completed'
      ? 'bg-green-900/40 text-green-300'
      : status === 'running'
        ? 'bg-yellow-900/40 text-yellow-300'
        : status === 'failed'
          ? 'bg-red-900/40 text-red-300'
          : 'bg-gray-800 text-gray-400'
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {t(`status.${status}`, { defaultValue: status })}
    </span>
  )
}

export default function Checklist() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const [error, setError] = useState('')

  const { data: checklist, isLoading, isError } = useQuery<ChecklistStatus>({
    queryKey: ['checklist', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: ChecklistStatus }>(
        `/orgs/${orgId}/recommendations/checklist`
      )
      return res.data
    },
  })

  const patchMutation = useMutation({
    mutationFn: (modules_config: Record<string, Record<string, unknown>>) =>
      api.patch(`/orgs/${orgId}/recommendations/checklist`, { modules_config }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['checklist', orgId] })
      setError('')
    },
    onError: () => setError(t('checklist.updateFailed')),
  })

  if (isLoading) return <div className="text-gray-500 text-sm">{t('common.loading')}</div>

  const config = checklist?.modules_config ?? {}

  const modules = ENGINE_MODULES.map((name) => ({
    name,
    enabled: (config[name]?.enabled as boolean | undefined) ?? true,
    thresholdDays: config[name]?.threshold_days as number | undefined,
  }))

  const enabledCount = modules.filter((m) => m.enabled).length
  const adoptionScore = modules.length ? Math.round((enabledCount / modules.length) * 100) : 0

  function toggleModule(name: string, enabled: boolean) {
    const next: Record<string, Record<string, unknown>> = {
      [name]: { ...(config[name] ?? {}), enabled },
    }
    patchMutation.mutate(next)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">{t('checklist.title')}</h2>
        <RunBadge status={checklist?.run_status ?? 'idle'} />
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
          {t('checklist.loadFailed')}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          label={t('checklist.adoptionScore')}
          value={`${adoptionScore}%`}
          sub={t('checklist.modulesEnabled', { enabled: enabledCount, total: modules.length })}
        />
        <StatCard label={t('checklist.activeRecommendations')} value={checklist?.recommendation_counts.active ?? 0} />
        <StatCard label={t('status.dismissed')} value={checklist?.recommendation_counts.dismissed ?? 0} />
        <StatCard
          label={t('checklist.lastEngineRun')}
          value={checklist?.last_completed_at ? new Date(checklist.last_completed_at).toLocaleDateString() : t('common.never')}
          sub={
            checklist?.last_run_at
              ? new Date(checklist.last_run_at).toLocaleString()
              : undefined
          }
        />
      </div>

      {checklist?.last_error && (
        <div className="mb-4 p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-400 text-sm">
          {t('checklist.lastRunFailed', { error: checklist.last_error })}
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-400 text-sm">
          {error}
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-800">
          <h3 className="text-sm font-semibold text-white">{t('checklist.detectionModules')}</h3>
        </div>
        <table className="w-full text-left">
          <thead className="border-b border-gray-800 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-3 font-medium">{t('checklist.colModule')}</th>
              <th className="px-4 py-3 font-medium">{t('checklist.colEnabled')}</th>
              <th className="px-4 py-3 font-medium">{t('checklist.colThreshold')}</th>
              <th className="px-4 py-3 font-medium">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {modules.map((m) => (
              <tr key={m.name} className="border-b border-gray-700 last:border-0 hover:bg-gray-800/40 transition-colors">
                <td className="px-4 py-3">
                  <span className="text-sm text-white font-mono">{m.name}</span>
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => toggleModule(m.name, !m.enabled)}
                    disabled={patchMutation.isPending}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
                      m.enabled ? 'bg-green-600' : 'bg-gray-700'
                    }`}
                    title={m.enabled ? t('checklist.disableTitle') : t('checklist.enableTitle')}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        m.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                      }`}
                    />
                  </button>
                </td>
                <td className="px-4 py-3 text-sm text-gray-400">
                  {m.thresholdDays ?? <span className="text-gray-600">{t('checklist.thresholdDefault')}</span>}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">
                  {m.enabled ? t('checklist.activeInEngine') : t('checklist.skippedByEngine')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
