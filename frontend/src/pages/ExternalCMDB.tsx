import { Table } from '@cloudflare/kumo/components/table'
import { Input, InputArea } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { NativeDialog } from '../components/shared/NativeDialog'
import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api, { paginatedGet } from '../lib/api'
import { usePagination } from '../lib/hooks/usePagination'
import PaginationBar from '../components/PaginationBar'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'

interface ExternalCmdbConfig {
  id: string
  name: string
  provider: string
  is_active: boolean
  last_sync_at: string | null
  created_at: string
  ci_type_id?: string | null
  sync_direction?: string
}

interface SyncLog {
  id: string
  started_at: string
  completed_at: string | null
  status: string
  records_pulled: number
  records_pushed: number
  records_created: number
  records_updated: number
  records_failed: number
  error?: string | null
}

interface DryRunResult {
  would_create: number
  would_update: number
  unchanged: number
  failed: number
  samples: Array<{ external_id: string; name?: string; action: string }>
}

const PROVIDERS = ['rest', 'servicenow', 'jira']

interface ConfigForm {
  name: string
  provider: string
  config: string
}

const DEFAULT_FORM: ConfigForm = { name: '', provider: 'rest', config: '' }

function configTemplate(provider: string): string {
  if (provider === 'servicenow') {
    return JSON.stringify(
      {
        base_url: 'https://instance.service-now.com',
        ci_type_id: '',
        sync_direction: 'pull',
        auth_config: { auth_type: 'basic', username: 'user', password: 'pass' },
        field_mapping: { external_id: 'sys_id', name: 'name', meta: { environment: 'environment' } },
        options: { table: 'cmdb_ci_linux' },
      },
      null,
      2,
    )
  }
  return JSON.stringify(
    {
      base_url: 'https://cmdb.example.com',
      ci_type_id: '',
      sync_direction: 'pull',
      auth_config: { auth_type: 'header', header_name: 'X-API-Key', token: 'key' },
      field_mapping: { external_id: 'id', name: 'name', meta: { environment: 'env' } },
      options: { list_path: 'api/v1/cis', push_path: 'api/v1/cis' },
    },
    null,
    2,
  )
}

export default function ExternalCMDB() {
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const { t } = useTranslation()

  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState<ConfigForm>(DEFAULT_FORM)
  const [formError, setFormError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null)

  const { data: configs = [], isLoading, isError } = useQuery<ExternalCmdbConfig[]>({
    queryKey: ['external-cmdb', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: ExternalCmdbConfig[] }>(`/orgs/${orgId}/external-cmdb`)
      return res.data ?? []
    },
  })

  const { data: ciTypes = [] } = useQuery<Array<{ id: string; display_name: string }>>({
    queryKey: ['ci-types', orgId],
    enabled: !!orgId && showModal,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: Array<{ id: string; display_name: string }> }>(`/orgs/${orgId}/ci-types`)
      return res.data ?? []
    },
  })

  // Sync logs for the selected config (T13).
  const { query: logsQuery, rows: logs, page, perPage, totalPages, total, setPage, setPerPage } =
    usePagination<SyncLog>(
      ['external-cmdb-logs', orgId, selectedId],
      (p, pp) =>
        paginatedGet<SyncLog>(`/orgs/${orgId}/external-cmdb/${selectedId}/logs`, {
          page: p,
          per_page: pp,
        }),
      { defaultPerPage: 10, enabled: !!orgId && !!selectedId },
    )
  const logsLoading = logsQuery.isLoading

  const createMutation = useMutation({
    mutationFn: (payload: { name: string; provider: string; config: unknown }) =>
      api.post(`/orgs/${orgId}/external-cmdb`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['external-cmdb', orgId] })
      setShowModal(false)
      setForm(DEFAULT_FORM)
      setFormError('')
    },
    onError: () => setFormError(t('externalCmdb.createFailed')),
  })

  const syncMutation = useMutation({
    mutationFn: (configId: string) => api.post(`/orgs/${orgId}/external-cmdb/${configId}/sync`, {}),
    onSuccess: () => {
      setMessage(t('externalCmdb.syncStarted'))
      queryClient.invalidateQueries({ queryKey: ['external-cmdb', orgId] })
      if (selectedId) queryClient.invalidateQueries({ queryKey: ['external-cmdb-logs', orgId, selectedId] })
    },
    onError: (err: any) => setMessage(err?.response?.data?.error?.message ?? t('externalCmdb.syncFailed')),
  })

  const dryRunMutation = useMutation({
    mutationFn: (configId: string) =>
      api.get<{ data: DryRunResult }>(`/orgs/${orgId}/external-cmdb/${configId}/dry-run`).then((r) => r.data.data),
    onSuccess: (data) => {
      setDryRun(data)
      setMessage('')
    },
    onError: (err: any) => setMessage(err?.response?.data?.error?.message ?? t('externalCmdb.dryRunFailed')),
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError('')
    if (!form.name.trim()) {
      setFormError(t('externalCmdb.nameRequired'))
      return
    }
    let config: unknown
    try {
      config = JSON.parse(form.config || configTemplate(form.provider))
    } catch {
      setFormError(t('externalCmdb.configInvalidJson'))
      return
    }
    createMutation.mutate({ name: form.name.trim(), provider: form.provider, config })
  }

  const selected = configs.find((c) => c.id === selectedId) ?? null

  function selectedCiTypeId(): string {
    try {
      return (JSON.parse(form.config || '{}') as { ci_type_id?: string }).ci_type_id ?? ''
    } catch {
      return ''
    }
  }

  function setConfigCiTypeId(id: string) {
    try {
      const cfg = JSON.parse(form.config || '{}')
      cfg.ci_type_id = id
      setForm({ ...form, config: JSON.stringify(cfg, null, 2) })
    } catch {
      /* template not valid JSON — leave as-is */
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('externalCmdb.title')}</h1>
        <Button
          variant="primary"
          onClick={() => {
            setForm({ name: '', provider: 'rest', config: configTemplate('rest') })
            setFormError('')
            setShowModal(true)
          }}
        >
          {t('externalCmdb.newConnection')}
        </Button>
      </div>

      {message && (
        <div className="mb-4 p-3 rounded-lg bg-info/10 border border-info/25 text-info text-sm">
          {message}
        </div>
      )}

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
          {t('externalCmdb.loadFailed')}
        </div>
      )}

      {isLoading ? (
        <div className="text-muted text-sm">{t('common.loading')}</div>
      ) : configs.length === 0 ? (
        <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
          {t('externalCmdb.empty')}
        </div>
      ) : (
        <div className="bg-surface border border-edge rounded-xl overflow-hidden mb-6">
          <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table className="text-left">
            <Table.Header variant="compact" className="border-b border-edge">
              <Table.Row>
                <Table.Head className="px-4 py-3 font-medium">{t('common.name')}</Table.Head>
                <Table.Head className="px-4 py-3 font-medium">{t('cmdb.provider')}</Table.Head>
                <Table.Head className="px-4 py-3 font-medium">{t('externalCmdb.direction')}</Table.Head>
                <Table.Head className="px-4 py-3 font-medium">{t('common.status')}</Table.Head>
                <Table.Head className="px-4 py-3 font-medium">{t('cloudAccounts.lastSync')}</Table.Head>
                <Table.Head className="px-4 py-3 font-medium">{t('common.actions')}</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {configs.map((c) => (
                <Table.Row
                  key={c.id}
                  className={`border-b border-strong last:border-0 hover:bg-subtle/40 transition-colors cursor-pointer ${
                    selectedId === c.id ? 'bg-accent-soft/20' : ''
                  }`}
                  onClick={() => {
                    setSelectedId(c.id)
                    setDryRun(null)
                    setMessage('')
                  }}
                >
                  <Table.Cell className="px-4 py-3 text-sm text-primary">{c.name}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-sm text-secondary">{c.provider}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-xs text-secondary">{c.sync_direction ?? 'pull'}</Table.Cell>
                  <Table.Cell className="px-4 py-3">
                    {c.is_active ? (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-success/10 text-success">
                        {t('common.active')}
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-subtle text-secondary">
                        {t('common.inactive')}
                      </span>
                    )}
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3 text-xs text-muted">
                    {c.last_sync_at ? new Date(c.last_sync_at).toLocaleString() : t('common.never')}
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    <Button
                      size="sm" variant="ghost"
                      onClick={() => dryRunMutation.mutate(c.id)}
                      disabled={dryRunMutation.isPending}
                      className="mr-3"
                      data-testid={`extcmdb-dryrun-${c.name}`}
                    >
                      {t('externalCmdb.dryRun')}
                    </Button>
                    <Button
                      size="sm" variant="ghost"
                      onClick={() => syncMutation.mutate(c.id)}
                      disabled={syncMutation.isPending}
                    >
                      {t('externalCmdb.syncNow')}
                    </Button>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table></div>
        </div>
      )}

      {/* Dry-run preview (T13) */}
      {dryRun && (
        <div className="bg-surface border border-edge rounded-xl p-4 mb-6 space-y-2" data-testid="extcmdb-dryrun-result">
          <h3 className="text-sm font-semibold text-primary">{t('externalCmdb.dryRunTitle')}</h3>
          <div className="flex gap-6 text-sm">
            <span className="text-success">+{dryRun.would_create} {t('externalCmdb.wouldCreate')}</span>
            <span className="text-warning">~{dryRun.would_update} {t('externalCmdb.wouldUpdate')}</span>
            <span className="text-muted">= {dryRun.unchanged} {t('externalCmdb.unchanged')}</span>
            {dryRun.failed > 0 && <span className="text-danger">✗{dryRun.failed}</span>}
          </div>
          {dryRun.samples.length > 0 && (
            <div className="text-xs text-secondary space-y-1">
              {dryRun.samples.slice(0, 5).map((s, i) => (
                <p key={i}>
                  <span className={s.action === 'create' ? 'text-success' : 'text-warning'}>{s.action}</span>{' '}
                  {s.name ?? s.external_id} <span className="text-muted">({s.external_id})</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Sync logs (T13) */}
      {selected && (
        <div className="bg-surface border border-edge rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-edge">
            <h3 className="text-sm font-semibold text-primary">
              {t('externalCmdb.syncHistory')} — {selected.name}
            </h3>
          </div>
          {logsLoading ? (
            <div className="p-5 text-muted text-sm">{t('common.loading')}</div>
          ) : logs.length === 0 ? (
            <div className="p-5 text-center text-muted text-sm">{t('externalCmdb.noSyncs')}</div>
          ) : (
            <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table className="text-left">
              <Table.Header variant="compact" className="border-b border-edge">
                <Table.Row>
                  <Table.Head className="px-4 py-3 font-medium">{t('externalCmdb.startedAt')}</Table.Head>
                  <Table.Head className="px-4 py-3 font-medium">{t('common.status')}</Table.Head>
                  <Table.Head className="px-4 py-3 font-medium">{t('externalCmdb.createdCol')}</Table.Head>
                  <Table.Head className="px-4 py-3 font-medium">{t('externalCmdb.updatedCol')}</Table.Head>
                  <Table.Head className="px-4 py-3 font-medium">{t('externalCmdb.pushedCol')}</Table.Head>
                  <Table.Head className="px-4 py-3 font-medium">{t('externalCmdb.failedCol')}</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {logs.map((l) => (
                  <Table.Row key={l.id} className="border-b border-strong last:border-0 hover:bg-subtle/40 transition-colors">
                    <Table.Cell className="px-4 py-3 text-xs text-secondary">
                      {new Date(l.started_at).toLocaleString()}
                      {l.error && <span className="block text-danger text-xs mt-0.5">{l.error}</span>}
                    </Table.Cell>
                    <Table.Cell className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          l.status === 'success'
                            ? 'bg-success/10 text-success'
                            : l.status === 'failed'
                              ? 'bg-danger/10 text-danger'
                              : 'bg-warning/10 text-warning'
                        }`}
                      >
                        {l.status}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="px-4 py-3 text-sm text-success">+{l.records_created}</Table.Cell>
                    <Table.Cell className="px-4 py-3 text-sm text-warning">~{l.records_updated}</Table.Cell>
                    <Table.Cell className="px-4 py-3 text-sm text-info">↑{l.records_pushed}</Table.Cell>
                    <Table.Cell className="px-4 py-3 text-sm text-danger">{l.records_failed}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table></div>
          )}
          {total > 0 && (
            <PaginationBar
              page={page}
              totalPages={totalPages}
              total={total}
              perPage={perPage}
              onPageChange={setPage}
              onPerPageChange={setPerPage}
            />
          )}
        </div>
      )}

      {showModal && (
        <NativeDialog className="items-center justify-center p-4" label={t('externalCmdb.newConnectionTitle')} onClose={() => setShowModal(false)}>
          <div
            className="dialog-panel p-6 w-full max-w-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-primary mb-4">{t('externalCmdb.newConnectionTitle')}</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Input
                    label={t('common.name')}
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full"
                    placeholder="prod-cmdb"
                  />
                </div>
                <div>
                  <SelectField
                    label={t('cmdb.provider')}
                    value={form.provider}
                    onValueChange={value =>
                      setForm({ ...form, provider: value, config: configTemplate(value) })}
                    className="w-full"
                    items={PROVIDERS.map((p) => ({ value: p, label: p }))}
                  />
                </div>
              </div>
              <div>
                <SelectField
                  label={t('externalCmdb.ciTypeHint')}
                  value={selectedCiTypeId()}
                  onValueChange={setConfigCiTypeId}
                  className="w-full"
                  items={[
                    { value: "", label: t('externalCmdb.selectCiType') },
                    ...ciTypes.map((ct) => ({ value: ct.id, label: ct.display_name })),
                  ]}
                />
              </div>
              <div>
                <InputArea
                  label={t('externalCmdb.configLabel')}
                  value={form.config}
                  onChange={(e) => setForm({ ...form, config: e.target.value })}
                  rows={10}
                  className="w-full font-mono resize-y"
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
                  disabled={createMutation.isPending}
                >
                  {t('externalCmdb.createConnection')}
                </Button>
              </div>
            </form>
          </div>
        </NativeDialog>
      )}
    </div>
  )
}
