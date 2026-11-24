import { PageTabs } from '../components/shared/PageTabs'
import { Table } from '@cloudflare/kumo/components/table'
import { Input, InputArea } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { NativeDialog } from '../components/shared/NativeDialog'
import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'
import { providerLabel } from '../lib/providers'
import type { CI, CIBaseline, DriftRecord } from '../types'

interface BaselineForm {
  ci_id: string
  label: string
  snapshot: string
}

const DEFAULT_FORM: BaselineForm = { ci_id: '', label: '', snapshot: '{}' }

function ValueCell({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted">null</span>
  if (typeof value === 'object') {
    return (
      <code className="text-xs text-secondary font-mono">
        {JSON.stringify(value).slice(0, 80)}
        {JSON.stringify(value).length > 80 ? '…' : ''}
      </code>
    )
  }
  return <span className="text-secondary">{String(value)}</span>
}

export default function DriftDetection() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const [tab, setTab] = useState<'drift' | 'baselines'>('drift')
  const [statusFilter, setStatusFilter] = useState<'all' | DriftRecord['status']>('all')
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState<BaselineForm>(DEFAULT_FORM)
  const [formError, setFormError] = useState('')

  const { data: drift = [], isLoading, isError } = useQuery<DriftRecord[]>({
    queryKey: ['ci-drift', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: DriftRecord[] }>(`/orgs/${orgId}/ci-drift`)
      return res.data ?? []
    },
  })

  const { data: baselines = [], isLoading: baselinesLoading } = useQuery<CIBaseline[]>({
    queryKey: ['ci-baselines', orgId],
    enabled: !!orgId && tab === 'baselines',
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CIBaseline[] }>(`/orgs/${orgId}/ci-baselines`)
      return res.data ?? []
    },
  })

  const { data: cis = [] } = useQuery<CI[]>({
    queryKey: ['cis', orgId],
    enabled: !!orgId && showModal,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CI[] }>(`/orgs/${orgId}/cis?limit=500`)
      return res.data ?? []
    },
  })

  // T12: drift lifecycle closure.
  const resolveMutation = useMutation({
    mutationFn: (driftId: string) => api.post(`/orgs/${orgId}/ci-drift/${driftId}/resolve`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ci-drift', orgId] }),
  })

  const ignoreMutation = useMutation({
    mutationFn: (driftId: string) => api.post(`/orgs/${orgId}/ci-drift/${driftId}/ignore`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ci-drift', orgId] }),
  })

  const acknowledgeMutation = useMutation({
    mutationFn: (driftId: string) => api.post(`/orgs/${orgId}/ci-drift/${driftId}/acknowledge`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ci-drift', orgId] }),
  })

  const createBaselineMutation = useMutation({
    mutationFn: (payload: { ci_id: string; snapshot: unknown; label?: string }) =>
      api.post(`/orgs/${orgId}/ci-baselines`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ci-baselines', orgId] })
      queryClient.invalidateQueries({ queryKey: ['ci-drift', orgId] })
      setShowModal(false)
      setForm(DEFAULT_FORM)
      setFormError('')
    },
    onError: () => setFormError(t('drift.captureFailed')),
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError('')
    if (!form.ci_id) {
      setFormError(t('drift.selectCiRequired'))
      return
    }
    let snapshot: unknown
    try {
      snapshot = JSON.parse(form.snapshot || '{}')
    } catch {
      setFormError(t('drift.snapshotInvalid'))
      return
    }
    createBaselineMutation.mutate({
      ci_id: form.ci_id,
      snapshot,
      ...(form.label.trim() ? { label: form.label.trim() } : {}),
    })
  }

  const visibleDrift = drift.filter(d => statusFilter === 'all' || d.status === statusFilter)

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('drift.title')}</h1>
        <Button
          variant="primary"
          onClick={() => {
            setShowModal(true)
            setFormError('')
          }}
        >
          {t('drift.captureBaseline')}
        </Button>
      </div>

      <PageTabs
        value={tab}
        onValueChange={setTab}
        className="mb-4"
        tabs={(['drift', 'baselines'] as const).map(tabKey => ({ value: tabKey, label: tabKey === 'drift' ? t('drift.tabDrift') : t('drift.tabBaselines') }))}
      />

      {tab === 'drift' ? (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {(['all', 'open', 'acknowledged', 'resolved', 'ignored'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  statusFilter === s
                    ? 'bg-accent text-on-accent'
                    : 'bg-subtle text-secondary hover:text-primary'
                }`}
              >
                {s === 'all' ? t('drift.filterAll') : t('drift.' + s)}
              </button>
            ))}
          </div>

          {isError && (
            <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
              {t('drift.loadFailed')}
            </div>
          )}

          {isLoading ? (
            <div className="text-muted text-sm">{t('common.loading')}</div>
          ) : visibleDrift.length === 0 ? (
            <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
              {drift.length === 0
                ? t('drift.empty')
                : t('drift.noMatchFilter')}
            </div>
          ) : (
            <div className="bg-surface border border-edge rounded-xl overflow-hidden">
              <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table className="text-left">
                <Table.Header variant="compact" className="border-b border-edge">
                  <Table.Row>
                    <Table.Head className="px-4 py-3 font-medium">{t('cmdb.colCi')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('drift.colField')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('drift.colBaselineCurrent')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('drift.colDetected')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('common.status')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('drift.colAction')}</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {visibleDrift.map((d) => (
                    <Table.Row key={d.id} className="border-b border-strong last:border-0 hover:bg-subtle/40 transition-colors">
                      <Table.Cell className="px-4 py-3 text-sm text-primary">{d.ci_name}</Table.Cell>
                      <Table.Cell className="px-4 py-3 text-sm font-mono text-secondary">{d.field_path}</Table.Cell>
                      <Table.Cell className="px-4 py-3">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="bg-danger/10 border border-danger/25 rounded px-2 py-1">
                            <ValueCell value={d.old_value} />
                          </span>
                          <span className="text-muted">→</span>
                          <span className="bg-success/10 border border-success/25 rounded px-2 py-1">
                            <ValueCell value={d.new_value} />
                          </span>
                        </div>
                      </Table.Cell>
                      <Table.Cell className="px-4 py-3 text-xs text-muted">
                        {new Date(d.detected_at).toLocaleString()}
                      </Table.Cell>
                      <Table.Cell className="px-4 py-3">
                        <span className={d.status === 'open'
                          ? 'px-2 py-0.5 rounded-full text-xs font-medium bg-warning/10 text-warning'
                          : 'px-2 py-0.5 rounded-full text-xs font-medium bg-subtle text-secondary'}>
                          {t('drift.' + d.status)}
                        </span>
                      </Table.Cell>
                      <Table.Cell className="px-4 py-3 whitespace-nowrap">
                        {(d.status === 'open' || d.status === 'acknowledged') && (
                          <>
                            {d.status === 'open' && <Button
                              size="sm" variant="ghost"
                              onClick={() => acknowledgeMutation.mutate(d.id)}
                              disabled={acknowledgeMutation.isPending}
                            >
                              {t('drift.acknowledge')}
                            </Button>}
                            <Button
                              size="sm" variant="ghost"
                              onClick={() => resolveMutation.mutate(d.id)}
                              disabled={resolveMutation.isPending}
                              className="ml-3"
                            >
                              {t('drift.resolve')}
                            </Button>
                            <Button
                              size="sm" variant="ghost"
                              onClick={() => ignoreMutation.mutate(d.id)}
                              disabled={ignoreMutation.isPending}
                              className="ml-3"
                            >
                              {t('drift.ignore')}
                            </Button>
                          </>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table></div>
            </div>
          )}
        </>
      ) : (
        <>
          {baselinesLoading ? (
            <div className="text-muted text-sm">{t('common.loading')}</div>
          ) : baselines.length === 0 ? (
            <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
              {t('drift.noBaselines')}
            </div>
          ) : (
            <div className="bg-surface border border-edge rounded-xl overflow-hidden">
              <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table className="text-left">
                <Table.Header variant="compact" className="border-b border-edge">
                  <Table.Row>
                    <Table.Head className="px-4 py-3 font-medium">{t('drift.colLabel')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('cmdb.colCi')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('drift.colSnapshot')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('drift.colCaptured')}</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {baselines.map((b) => (
                    <Table.Row key={b.id} className="border-b border-strong last:border-0 hover:bg-subtle/40 transition-colors">
                      <Table.Cell className="px-4 py-3 text-sm text-primary">{b.label ?? '—'}</Table.Cell>
                      <Table.Cell className="px-4 py-3 text-sm text-secondary">{b.ci_name}</Table.Cell>
                      <Table.Cell className="px-4 py-3">
                        <code className="text-xs text-secondary font-mono">
                          {JSON.stringify(b.snapshot).slice(0, 100)}
                          {JSON.stringify(b.snapshot).length > 100 ? '…' : ''}
                        </code>
                      </Table.Cell>
                      <Table.Cell className="px-4 py-3 text-xs text-muted">
                        {new Date(b.created_at).toLocaleString()}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table></div>
            </div>
          )}
        </>
      )}

      {showModal && (
        <NativeDialog className="items-center justify-center p-4" label={t('drift.captureBaselineTitle')} onClose={() => setShowModal(false)}>
          <div
            className="dialog-panel p-6 w-full max-w-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-primary mb-4">{t('drift.captureBaselineTitle')}</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <SelectField
                  label={t('cmdb.colCi')}
                  value={form.ci_id}
                  onValueChange={value => setForm({ ...form, ci_id: value })}
                  className="w-full"
                  items={[
                    { value: "", label: t('drift.selectCi') },
                    ...cis.map((ci) => ({ value: ci.id, label: `${ci.display_name} (${providerLabel(ci.cloud_provider)})` })),
                  ]}
                />
              </div>
              <div>
                <Input
                  label={t('drift.labelOptional')}
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  className="w-full"
                  placeholder="e.g. prod-2026-08-13"
                />
              </div>
              <div>
                <InputArea
                  label={t('drift.snapshotLabel')}
                  value={form.snapshot}
                  onChange={(e) => setForm({ ...form, snapshot: e.target.value })}
                  rows={6}
                  className="w-full font-mono resize-y"
                  placeholder='{"cpu_count": 4, "memory_gb": 16}'
                />
              </div>
              {formError && (
                <div className="p-3 rounded-lg bg-danger/10 border border-danger/25 text-danger text-sm">
                  {formError}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => setShowModal(false)}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={createBaselineMutation.isPending}
                >
                  {t('drift.capture')}
                </Button>
              </div>
            </form>
          </div>
        </NativeDialog>
      )}
    </div>
  )
}
