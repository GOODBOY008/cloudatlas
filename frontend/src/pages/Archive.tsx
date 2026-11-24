import { PageTabs } from '../components/shared/PageTabs'
import { Button } from '@cloudflare/kumo/components/button'
import { Table } from '@cloudflare/kumo/components/table'
import { storageRecommendationType } from '../lib/objectStorage'
import { useMoneyFormatter } from '../lib/format'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'

interface ArchivedRec { id: string; rec_type: string; saving: number; resource_id: string; status: string; created_at: string; dismissed_at?: string }
interface AlertEvent { id: string; alert_id: string; alert_name: string; triggered_at: string; cost: number; message: string }


export default function Archive() {
  const fmt = useMoneyFormatter()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id ?? ''
  const qc = useQueryClient()
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<'recommendations' | 'alerts'>('recommendations')

  const { data: archivedRecs, isLoading: recLoading } = useQuery({
    queryKey: ['archived-recs', orgId],
    queryFn: () => api.get<{ data: ArchivedRec[] }>(`/orgs/${orgId}/recommendations?status=archived&limit=100`).then(r => r.data.data ?? []),
    enabled: !!orgId,
  })

  const { data: alertEvents, isLoading: evLoading } = useQuery({
    queryKey: ['alert-events', orgId],
    queryFn: () => api.get<{ data: AlertEvent[] }>(`/orgs/${orgId}/alert-events?limit=100`).then(r => r.data.data ?? []),
    enabled: !!orgId,
  })

  const reactivate = useMutation({
    mutationFn: (id: string) => api.post(`/orgs/${orgId}/recommendations/${id}/reactivate`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['archived-recs', orgId] }),
  })

  const recs = archivedRecs ?? []
  const events = alertEvents ?? []

  const totalArchivedSavings = recs.reduce((s, r) => s + (r.saving ?? 0), 0)

  return (
    <div className="space-y-6">
      <div className="page-heading">
        <h1 className="page-title">{t('archive.title')}</h1>
        <p className="text-sm text-secondary mt-1">{t('archive.subtitle')}</p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-surface rounded-xl border border-strong p-5">
          <p className="text-xs text-secondary uppercase tracking-wider">{t('archive.archivedRecommendations')}</p>
          <p className="text-2xl font-semibold text-secondary mt-1">{recs.length}</p>
          <p className="text-xs text-muted mt-1">{t('archive.deferredSavings', { amount: fmt(totalArchivedSavings) })}</p>
        </div>
        <div className="bg-surface rounded-xl border border-strong p-5">
          <p className="text-xs text-secondary uppercase tracking-wider">{t('archive.alertEvents')}</p>
          <p className="text-2xl font-semibold text-secondary mt-1">{events.length}</p>
          <p className="text-xs text-muted mt-1">{t('archive.historicalTriggers')}</p>
        </div>
        <div className="bg-surface rounded-xl border border-strong p-5">
          <p className="text-xs text-secondary uppercase tracking-wider">{t('archive.reactivatable')}</p>
          <p className="text-2xl font-semibold text-accent mt-1">{recs.filter(r => r.status === 'archived').length}</p>
          <p className="text-xs text-muted mt-1">{t('archive.recommendations')}</p>
        </div>
      </div>

      {/* Tabs */}
      <PageTabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="mb-5"
        tabs={[
          { value: 'recommendations', label: t('archive.tabRecommendations', { count: recs.length }) },
          { value: 'alerts', label: t('archive.tabAlertHistory', { count: events.length }) },
        ]}
      />

      {activeTab === 'recommendations' && (
        <div className="bg-surface rounded-xl border border-strong overflow-hidden">
          <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
            <Table.Header variant="compact"><Table.Row className="border-b border-strong">
              {['common.type', 'archive.colResource', 'archive.colSavingPerMonth', 'common.status', 'archive.colArchived', 'common.actions'].map(h => (
                <Table.Head key={h} className="px-4 py-3 text-left">{t(h)}</Table.Head>
              ))}
            </Table.Row></Table.Header>
            <Table.Body className="divide-y divide-edge">
              {recLoading ? (
                <Table.Row><Table.Cell colSpan={6} className="px-4 py-10 text-center text-muted">{t('common.loading')}</Table.Cell></Table.Row>
              ) : recs.length === 0 ? (
                <Table.Row><Table.Cell colSpan={6} className="px-4 py-10 text-center text-muted">{t('archive.noArchivedRecs')}</Table.Cell></Table.Row>
              ) : recs.map(r => (
                <Table.Row key={r.id} className="hover:bg-subtle">
                  <Table.Cell className="px-4 py-3">
                    <span className="px-2 py-0.5 bg-emphasis text-secondary rounded text-xs">{t(`archive.recType.${r.rec_type}`, { defaultValue: storageRecommendationType(r.rec_type) })}</span>
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary font-mono text-xs">{r.resource_id?.slice(0, 24)}…</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-success font-semibold">{fmt(r.saving ?? 0)}</Table.Cell>
                  <Table.Cell className="px-4 py-3">
                    <span className="px-2 py-0.5 bg-emphasis text-secondary rounded-full text-xs">{t(`status.${r.status}`, { defaultValue: r.status })}</span>
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary text-xs">{r.created_at?.slice(0, 10)}</Table.Cell>
                  <Table.Cell className="px-4 py-3">
                    <Button
                      size="sm" variant="ghost"
                      onClick={() => reactivate.mutate(r.id)}
                      disabled={reactivate.isPending}
                    >
                      {t('archive.restore')}
                    </Button>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table></div>
        </div>
      )}

      {activeTab === 'alerts' && (
        <div className="bg-surface rounded-xl border border-strong overflow-hidden">
          <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
            <Table.Header variant="compact"><Table.Row className="border-b border-strong">
              {['archive.colAlert', 'archive.colTriggeredAt', 'archive.colCostAtTrigger', 'archive.colMessage'].map(h => (
                <Table.Head key={h} className="px-4 py-3 text-left">{t(h)}</Table.Head>
              ))}
            </Table.Row></Table.Header>
            <Table.Body className="divide-y divide-edge">
              {evLoading ? (
                <Table.Row><Table.Cell colSpan={4} className="px-4 py-10 text-center text-muted">{t('common.loading')}</Table.Cell></Table.Row>
              ) : events.length === 0 ? (
                <Table.Row><Table.Cell colSpan={4} className="px-4 py-10 text-center text-muted">{t('archive.noAlertEvents')}</Table.Cell></Table.Row>
              ) : events.map(e => (
                <Table.Row key={e.id} className="hover:bg-subtle">
                  <Table.Cell className="px-4 py-3 font-medium text-primary">{e.alert_name ?? t('archive.alert')}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary">{e.triggered_at?.slice(0, 16)}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-danger font-semibold">{fmt(e.cost ?? 0)}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary text-xs">{e.message ?? '—'}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table></div>
        </div>
      )}
    </div>
  )
}
