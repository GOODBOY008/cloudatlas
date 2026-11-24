import { PageTabs } from '../components/shared/PageTabs'
import { Table } from '@cloudflare/kumo/components/table'
import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { NativeDialog } from '../components/shared/NativeDialog'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'

interface Policy {
  id: string
  name: string
  description?: string
  policy_type: 'ttl' | 'idle_shutdown' | 'tag_based' | 'schedule_based'
  ttl_days?: number
  idle_days?: number
  action: 'flag' | 'notify' | 'decommission' | 'stop'
  is_active: boolean
  last_evaluated_at?: string
  created_at: string
}

interface LifecycleEvent {
  id: string
  policy_name?: string
  cloud_resource_id?: string
  resource_type?: string
  event_type: string
  reason?: string
  actor_name?: string
  created_at: string
}

const actionColors: Record<string, string> = {
  flag:          'bg-info/10 text-info',
  notify:        'bg-accent-soft/50 text-accent',
  decommission:  'bg-danger/10 text-danger',
  stop:          'bg-warning/10 text-warning',
}

const eventColors: Record<string, string> = {
  flagged:        'text-warning',
  notified:       'text-info',
  decommissioned: 'text-danger',
  stopped:        'text-warning',
  exempted:       'text-success',
  restored:       'text-success',
}

export default function ResourceLifecycle() {
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id ?? ''
  const qc = useQueryClient()

  const [activeTab, setActiveTab] = useState<'policies' | 'events'>('policies')
  const [showCreate, setShowCreate] = useState(false)
  const [evaluatingId, setEvaluatingId] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '', description: '', policy_type: 'ttl', ttl_days: 30, idle_days: 14, action: 'flag',
  })

  const { data: policies, isLoading: policyLoading } = useQuery({
    queryKey: ['lifecycle-policies', orgId],
    queryFn: () => api.get<{ data: Policy[] }>(`/orgs/${orgId}/lifecycle-policies`).then(r => r.data.data ?? []),
    enabled: !!orgId,
  })

  const { data: events, isLoading: eventLoading } = useQuery({
    queryKey: ['lifecycle-events', orgId],
    queryFn: () => api.get<{ data: LifecycleEvent[] }>(`/orgs/${orgId}/lifecycle-events`).then(r => r.data.data ?? []),
    enabled: !!orgId,
  })

  const createPolicy = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/lifecycle-policies`, {
      name: form.name,
      description: form.description || undefined,
      policy_type: form.policy_type,
      ttl_days: form.policy_type === 'ttl' ? form.ttl_days : undefined,
      idle_days: form.policy_type === 'idle_shutdown' ? form.idle_days : undefined,
      action: form.action,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['lifecycle-policies', orgId] }); setShowCreate(false) },
  })

  const deletePolicy = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/lifecycle-policies/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lifecycle-policies', orgId] }),
  })

  const evaluatePolicy = useMutation({
    mutationFn: (id: string) => {
      setEvaluatingId(id)
      return api.post<{ flagged_count: number }>(`/orgs/${orgId}/lifecycle-policies/${id}/evaluate`, {})
    },
    onSuccess: (res, _id) => {
      const count = res.data.flagged_count ?? 0
      alert(t('resourceLifecycle.evaluationComplete', { count }))
      setEvaluatingId(null)
      qc.invalidateQueries({ queryKey: ['lifecycle-policies', orgId] })
      qc.invalidateQueries({ queryKey: ['lifecycle-events', orgId] })
    },
    onError: () => setEvaluatingId(null),
  })

  const pols = policies ?? []
  const evts = events ?? []
  const activePolicies = pols.filter(p => p.is_active).length

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('resourceLifecycle.title')}</h1>
          <p className="text-sm text-secondary mt-1">{t('resourceLifecycle.subtitle')}</p>
        </div>
        <Button variant="primary" onClick={() => setShowCreate(true)}>
          {t('resourceLifecycle.newPolicy')}
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-surface rounded-xl border border-strong p-5">
          <p className="text-xs text-secondary uppercase tracking-wider">{t('resourceLifecycle.totalPolicies')}</p>
          <p className="text-2xl font-semibold text-primary mt-1">{pols.length}</p>
        </div>
        <div className="bg-surface rounded-xl border border-strong p-5">
          <p className="text-xs text-secondary uppercase tracking-wider">{t('common.active')}</p>
          <p className="text-2xl font-semibold text-success mt-1">{activePolicies}</p>
        </div>
        <div className="bg-surface rounded-xl border border-strong p-5">
          <p className="text-xs text-secondary uppercase tracking-wider">{t('resourceLifecycle.lifecycleEvents')}</p>
          <p className="text-2xl font-semibold text-warning mt-1">{evts.length}</p>
        </div>
      </div>

      {/* Tabs */}
      <PageTabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="mb-5"
        tabs={[
          { value: 'policies', label: t('resourceLifecycle.tabPolicies', { count: pols.length }) },
          { value: 'events', label: t('resourceLifecycle.tabEvents', { count: evts.length }) },
        ]}
      />

      {activeTab === 'policies' && (
        <div className="bg-surface rounded-xl border border-strong overflow-hidden">
          <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
            <Table.Header variant="compact"><Table.Row className="border-b border-strong">
              {['common.name', 'common.type', 'resourceLifecycle.colThreshold', 'resourceLifecycle.colAction', 'common.active', 'resourceLifecycle.colLastRun', 'common.actions'].map(h => (
                <Table.Head key={h} className="px-4 py-3 text-left">{t(h)}</Table.Head>
              ))}
            </Table.Row></Table.Header>
            <Table.Body className="divide-y divide-edge">
              {policyLoading ? (
                <Table.Row><Table.Cell colSpan={7} className="px-4 py-10 text-center text-muted">{t('common.loading')}</Table.Cell></Table.Row>
              ) : pols.length === 0 ? (
                <Table.Row><Table.Cell colSpan={7} className="px-4 py-10 text-center text-muted">{t('resourceLifecycle.noPolicies')}</Table.Cell></Table.Row>
              ) : pols.map(p => (
                <Table.Row key={p.id} className="hover:bg-subtle">
                  <Table.Cell className="px-4 py-3">
                    <p className="font-medium text-primary">{p.name}</p>
                    {p.description && <p className="text-xs text-muted mt-0.5">{p.description}</p>}
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary text-xs">{t(`resourceLifecycle.policyType.${p.policy_type}`, { defaultValue: p.policy_type })}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary text-xs">
                    {p.policy_type === 'ttl' && p.ttl_days != null ? t('resourceLifecycle.ttlDays', { days: p.ttl_days }) : null}
                    {p.policy_type === 'idle_shutdown' && p.idle_days != null ? t('resourceLifecycle.idleDays', { days: p.idle_days }) : null}
                    {p.policy_type !== 'ttl' && p.policy_type !== 'idle_shutdown' ? '—' : null}
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${actionColors[p.action] ?? ''}`}>{t(`resourceLifecycle.action.${p.action}`, { defaultValue: p.action })}</span>
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3">
                    <span className={`text-xs font-semibold ${p.is_active ? 'text-success' : 'text-muted'}`}>
                      {p.is_active ? t('resourceLifecycle.yes') : t('resourceLifecycle.no')}
                    </span>
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary text-xs">
                    {p.last_evaluated_at ? new Date(p.last_evaluated_at).toLocaleString() : t('common.never')}
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3 flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => evaluatePolicy.mutate(p.id)}
                      disabled={evaluatingId === p.id}>
                      {evaluatingId === p.id ? t('resourceLifecycle.running') : t('resourceLifecycle.run')}
                    </Button>
                    <Button size="sm" variant="secondary-destructive" onClick={() => { if (confirm(t('resourceLifecycle.confirmDelete'))) deletePolicy.mutate(p.id) }}>
                      {t('common.delete')}
                    </Button>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table></div>
        </div>
      )}

      {activeTab === 'events' && (
        <div className="bg-surface rounded-xl border border-strong overflow-hidden">
          <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
            <Table.Header variant="compact"><Table.Row className="border-b border-strong">
              {['resourceLifecycle.colEvent', 'pools.colResource', 'common.type', 'resourceLifecycle.colPolicy', 'resourceLifecycle.colReason', 'resourceLifecycle.colTime'].map(h => (
                <Table.Head key={h} className="px-4 py-3 text-left">{t(h)}</Table.Head>
              ))}
            </Table.Row></Table.Header>
            <Table.Body className="divide-y divide-edge">
              {eventLoading ? (
                <Table.Row><Table.Cell colSpan={6} className="px-4 py-10 text-center text-muted">{t('common.loading')}</Table.Cell></Table.Row>
              ) : evts.length === 0 ? (
                <Table.Row><Table.Cell colSpan={6} className="px-4 py-10 text-center text-muted">{t('resourceLifecycle.noEvents')}</Table.Cell></Table.Row>
              ) : evts.map(e => (
                <Table.Row key={e.id} className="hover:bg-subtle">
                  <Table.Cell className="px-4 py-3">
                    <span className={`font-medium capitalize ${eventColors[e.event_type] ?? 'text-secondary'}`}>
                      {t(`resourceLifecycle.eventType.${e.event_type}`, { defaultValue: e.event_type })}
                    </span>
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3 font-mono text-xs text-secondary">{e.cloud_resource_id?.slice(0, 30) ?? '—'}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary text-xs">{e.resource_type ?? '—'}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary text-xs">{e.policy_name ?? '—'}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary text-xs max-w-xs truncate">{e.reason ?? '—'}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary text-xs">{e.created_at?.slice(0, 16)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table></div>
        </div>
      )}

      {/* Create Policy Modal */}
      {showCreate && (
        <NativeDialog className="items-center justify-center p-4" label={t('resourceLifecycle.newPolicyTitle')} onClose={() => setShowCreate(false)}>
          <form className="dialog-panel p-6 w-full max-w-md space-y-4" onSubmit={e => { e.preventDefault(); createPolicy.mutate() }}>
            <h2 className="text-lg font-bold text-primary">{t('resourceLifecycle.newPolicyTitle')}</h2>
            <div className="space-y-3">
              <div>
                <Input label={`${t('common.name')} *`} value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  className="w-full"
                  placeholder={t('resourceLifecycle.namePlaceholder')} />
              </div>
              <div>
                <SelectField
                  label={t('resourceLifecycle.policyType')}
                  value={form.policy_type}
                  onValueChange={value => setForm(p => ({ ...p, policy_type: value }))}
                  className="w-full"
                  items={[
                    { value: "ttl", label: t('resourceLifecycle.typeTtlOption') },
                    { value: "idle_shutdown", label: t('resourceLifecycle.typeIdleOption') },
                  ]}
                />
              </div>
              {form.policy_type === 'ttl' && (
                <div>
                  <Input
                    label={t('resourceLifecycle.ttlDaysLabel')} type="number" min={1} value={form.ttl_days}
                    onChange={e => setForm(p => ({ ...p, ttl_days: parseInt(e.target.value) || 30 }))}
                    className="w-full" />
                </div>
              )}
              {form.policy_type === 'idle_shutdown' && (
                <div>
                  <Input
                    label={t('resourceLifecycle.idleDaysLabel')} type="number" min={1} value={form.idle_days}
                    onChange={e => setForm(p => ({ ...p, idle_days: parseInt(e.target.value) || 14 }))}
                    className="w-full" />
                </div>
              )}
              <div>
                <SelectField
                  label={t('resourceLifecycle.colAction')}
                  value={form.action}
                  onValueChange={value => setForm(p => ({ ...p, action: value }))}
                  className="w-full"
                  items={[
                    { value: "flag", label: t('resourceLifecycle.optionFlag') },
                    { value: "notify", label: t('resourceLifecycle.optionNotify') },
                    { value: "stop", label: t('resourceLifecycle.optionStop') },
                    { value: "decommission", label: t('resourceLifecycle.optionDecommission') },
                  ]}
                />
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <Button type="button" onClick={() => setShowCreate(false)}
                className="flex-1">
                {t('common.cancel')}
              </Button>
              <Button variant="primary" type="submit"
                disabled={createPolicy.isPending || !form.name.trim()}
                className="flex-1">
                {createPolicy.isPending ? t('resourceLifecycle.creating') : t('resourceLifecycle.createPolicy')}
              </Button>
            </div>
          </form>
        </NativeDialog>
      )}
    </div>
  )
}
