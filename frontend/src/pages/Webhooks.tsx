import { PageTabs } from '../components/shared/PageTabs'
import { Table } from '@cloudflare/kumo/components/table'
import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { NativeDialog } from '../components/shared/NativeDialog'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import api, { paginatedGet } from '../lib/api'
import { usePagination } from '../lib/hooks/usePagination'
import PaginationBar from '../components/PaginationBar'
import { useOrgStore } from '../store/orgStore'
import type { Webhook, WebhookEvent } from '../types'

const EVENT_OPTIONS = [
  'recommendation.created',
  'budget.exceeded',
  'anomaly.detected',
  'resource.discovered',
  'sync.completed',
  'sync.failed',
  'billing.imported',
  'billing.failed',
]

interface WebhookForm {
  name: string
  url: string
  events: string[]
  secret: string
  channel: string
}

/** Payload sent to the API — secret optional (kept server-side when blank on update). */
type WebhookPayload = {
  name: string
  url: string
  events: string[]
  secret?: string
  channel?: string
}

const DEFAULT_FORM: WebhookForm = {
  name: '',
  url: '',
  events: ['budget.exceeded'],
  secret: '',
  channel: 'generic',
}

const CHANNEL_OPTIONS = [
  { value: 'generic', label: 'webhooks.channelGeneric' },
  { value: 'slack', label: 'webhooks.channelSlack' },
  { value: 'teams', label: 'webhooks.channelTeams' },
  { value: 'pagerduty', label: 'webhooks.channelPagerduty' },
  { value: 'email', label: 'webhooks.channelEmail' },
]

function ChannelBadge({ channel }: { channel: string }) {
  const color =
    channel === 'slack'
      ? 'bg-success/10 text-success'
      : channel === 'teams'
        ? 'bg-violet/10 text-violet'
        : channel === 'pagerduty'
          ? 'bg-warning/10 text-warning'
          : channel === 'email'
            ? 'bg-info/10 text-info'
            : 'bg-subtle text-secondary'
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>{channel}</span>
}

function EventBadge({ event }: { event: string }) {
  const color =
    event === 'budget.exceeded'
      ? 'bg-danger/10 text-danger'
      : event === 'anomaly.detected'
        ? 'bg-warning/10 text-warning'
        : event === 'recommendation.created'
          ? 'bg-success/10 text-success'
          : 'bg-info/10 text-info'
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {event}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation()
  const cls =
    status === 'delivered'
      ? 'bg-success/10 text-success'
      : status === 'failed'
        ? 'bg-danger/10 text-danger'
        : status === 'pending'
          ? 'bg-warning/10 text-warning'
          : 'bg-subtle text-secondary'
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {t(`status.${status}`, { defaultValue: status })}
    </span>
  )
}

export default function Webhooks() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const [tab, setTab] = useState<'webhooks' | 'events'>('webhooks')
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<WebhookForm>(DEFAULT_FORM)
  const [formError, setFormError] = useState('')

  const { query: webhooksQuery, rows: webhooks, page, perPage, totalPages, setPage, setPerPage } =
    usePagination<Webhook>(
      ['webhooks', orgId],
      (p, pp) => paginatedGet<Webhook>(`/orgs/${orgId}/webhooks`, { page: p, per_page: pp }),
      { defaultPerPage: 50, enabled: !!orgId },
    )
  const { isLoading, isError } = webhooksQuery

  // Delivery log — real paging so the table no longer silently truncates at
  // the backend's default page size.
  const {
    query: eventsQuery,
    rows: events,
    page: eventsPage,
    perPage: eventsPerPage,
    totalPages: eventsTotalPages,
    setPage: setEventsPage,
    setPerPage: setEventsPerPage,
  } = usePagination<WebhookEvent>(
    ['webhook-events', orgId],
    (p, pp) => paginatedGet<WebhookEvent>(`/orgs/${orgId}/webhook-events`, { page: p, per_page: pp }),
    { defaultPerPage: 50, enabled: !!orgId && tab === 'events' },
  )
  const { isLoading: eventsLoading } = eventsQuery

  const createMutation = useMutation({
    mutationFn: (payload: WebhookPayload) => api.post(`/orgs/${orgId}/webhooks`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks', orgId] })
      closeModal()
    },
    onError: () => setFormError(t('webhooks.createFailed')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: WebhookPayload }) =>
      api.put(`/orgs/${orgId}/webhooks/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks', orgId] })
      closeModal()
    },
    onError: () => setFormError(t('webhooks.updateFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/webhooks/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['webhooks', orgId] }),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      api.put(`/orgs/${orgId}/webhooks/${id}`, { is_active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['webhooks', orgId] }),
  })

  function openCreate() {
    setEditingId(null)
    setForm(DEFAULT_FORM)
    setFormError('')
    setShowModal(true)
  }

  function openEdit(hook: Webhook) {
    setEditingId(hook.id)
    setForm({
      name: hook.name,
      url: hook.url,
      events: hook.events,
      secret: '',
      channel: hook.channel ?? 'generic',
    })
    setFormError('')
    setShowModal(true)
  }

  function closeModal() {
    setShowModal(false)
    setEditingId(null)
    setFormError('')
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError('')
    if (!form.name.trim() || !form.url.trim()) {
      setFormError(t('webhooks.nameUrlRequired'))
      return
    }
    if (form.events.length === 0) {
      setFormError(t('webhooks.eventRequired'))
      return
    }
    const payload: WebhookPayload = {
      name: form.name,
      url: form.url,
      events: form.events,
      channel: form.channel,
      ...(form.secret.trim() ? { secret: form.secret.trim() } : {}),
    }
    if (editingId) {
      updateMutation.mutate({ id: editingId, payload })
    } else {
      createMutation.mutate(payload)
    }
  }

  function toggleEvent(event: string) {
    setForm((f) => ({
      ...f,
      events: f.events.includes(event)
        ? f.events.filter((e) => e !== event)
        : [...f.events, event],
    }))
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('webhooks.title')}</h1>
        <Button
          variant="primary"
          onClick={openCreate}
        >
          {t('webhooks.newWebhook')}
        </Button>
      </div>

      <PageTabs
        value={tab}
        onValueChange={setTab}
        className="mb-4"
        tabs={(['webhooks', 'events'] as const).map(tabKey => ({ value: tabKey, label: tabKey === 'webhooks' ? t('webhooks.tabEndpoints') : t('webhooks.tabDeliveryLog') }))}
      />

      {tab === 'webhooks' ? (
        <>
          {isError && (
            <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
              {t('webhooks.loadFailed')}
            </div>
          )}

          {isLoading ? (
            <div className="text-muted text-sm">{t('common.loading')}</div>
          ) : webhooks.length === 0 ? (
            <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
              {t('webhooks.empty')}
            </div>
          ) : (
            <div className="bg-surface border border-edge rounded-xl overflow-hidden">
              <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table className="text-left">
                <Table.Header variant="compact" className="border-b border-edge">
                  <Table.Row>
                    <Table.Head className="px-4 py-3 font-medium">{t('common.name')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('webhooks.colUrl')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('webhooks.colChannel')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('webhooks.colEvents')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('common.status')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('webhooks.colLastDelivery')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('common.actions')}</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {webhooks.map((hook) => (
                    <Table.Row key={hook.id} className="border-b border-strong last:border-0 hover:bg-subtle/40 transition-colors">
                      <Table.Cell className="px-4 py-3 text-sm text-primary">{hook.name}</Table.Cell>
                      <Table.Cell className="px-4 py-3 text-sm font-mono text-secondary max-w-[240px] truncate">{hook.url}</Table.Cell>
                      <Table.Cell className="px-4 py-3">
                        <ChannelBadge channel={hook.channel ?? 'generic'} />
                      </Table.Cell>
                      <Table.Cell className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {hook.events.map((ev) => (
                            <EventBadge key={ev} event={ev} />
                          ))}
                        </div>
                      </Table.Cell>
                      <Table.Cell className="px-4 py-3">
                        <button
                          onClick={() =>
                            toggleMutation.mutate({ id: hook.id, is_active: !hook.is_active })
                          }
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                            hook.is_active ? 'bg-success-solid' : 'bg-emphasis'
                          }`}
                          title={hook.is_active ? t('webhooks.toggleDeactivate') : t('webhooks.toggleActivate')}
                        >
                          <span
                            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-surface transition-transform ${
                              hook.is_active ? 'translate-x-[18px]' : 'translate-x-[3px]'
                            }`}
                          />
                        </button>
                      </Table.Cell>
                      <Table.Cell className="px-4 py-3 text-xs text-muted">
                        {hook.last_triggered_at ? (
                          <>
                            <div>{new Date(hook.last_triggered_at).toLocaleString()}</div>
                            {hook.last_status !== null && (
                              <div className="mt-0.5 font-mono text-secondary">HTTP {hook.last_status}</div>
                            )}
                          </>
                        ) : (
                          t('common.never')
                        )}
                      </Table.Cell>
                      <Table.Cell className="px-4 py-3">
                        <div className="flex items-center gap-3 text-xs">
                          <Button
                            size="sm" variant="ghost"
                            onClick={() => openEdit(hook)}
                          >
                            {t('common.edit')}
                          </Button>
                          <Button
                            size="sm" variant="secondary-destructive"
                            onClick={() => {
                              if (confirm(t('webhooks.deleteConfirm', { name: hook.name }))) {
                                deleteMutation.mutate(hook.id)
                              }
                            }}
                          >
                            {t('common.delete')}
                          </Button>
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table></div>
              <PaginationBar
                page={page}
                totalPages={totalPages}
                total={webhooksQuery.data?.meta.total ?? 0}
                perPage={perPage}
                onPageChange={setPage}
                onPerPageChange={setPerPage}
              />
            </div>
          )}
        </>
      ) : (
        <>
          {eventsLoading ? (
            <div className="text-muted text-sm">{t('common.loading')}</div>
          ) : events.length === 0 ? (
            <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
              {t('webhooks.noEvents')}
            </div>
          ) : (
            <div className="bg-surface border border-edge rounded-xl overflow-hidden">
              <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table className="text-left">
                <Table.Header variant="compact" className="border-b border-edge">
                  <Table.Row>
                    <Table.Head className="px-4 py-3 font-medium">{t('webhooks.colWebhook')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('webhooks.colEvent')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('common.status')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('webhooks.colAttempts')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('webhooks.colResponse')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('common.created')}</Table.Head>
                    <Table.Head className="px-4 py-3 font-medium">{t('webhooks.colDelivered')}</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {events.map((ev) => (
                    <Table.Row key={ev.id} className="border-b border-strong last:border-0 hover:bg-subtle/40 transition-colors">
                      <Table.Cell className="px-4 py-3 text-sm text-primary">{ev.webhook_name}</Table.Cell>
                      <Table.Cell className="px-4 py-3">
                        <EventBadge event={ev.event_type} />
                      </Table.Cell>
                      <Table.Cell className="px-4 py-3">
                        <StatusBadge status={ev.status} />
                      </Table.Cell>
                      <Table.Cell className="px-4 py-3 text-sm text-secondary">{ev.attempts}</Table.Cell>
                      <Table.Cell className="px-4 py-3 text-sm font-mono text-secondary">
                        {ev.response_status ?? '—'}
                      </Table.Cell>
                      <Table.Cell className="px-4 py-3 text-xs text-muted">
                        {new Date(ev.created_at).toLocaleString()}
                      </Table.Cell>
                      <Table.Cell className="px-4 py-3 text-xs text-muted">
                        {ev.delivered_at ? new Date(ev.delivered_at).toLocaleString() : '—'}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table></div>
              <PaginationBar
                page={eventsPage}
                totalPages={eventsTotalPages}
                total={eventsQuery.data?.meta.total ?? 0}
                perPage={eventsPerPage}
                onPageChange={setEventsPage}
                onPerPageChange={setEventsPerPage}
              />
            </div>
          )}
        </>
      )}

      {showModal && (
        <NativeDialog className="items-center justify-center p-4" label={editingId ? t('webhooks.editTitle') : t('webhooks.newTitle')} onClose={closeModal}>
          <div
            className="dialog-panel p-6 w-full max-w-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-primary mb-4">
              {editingId ? t('webhooks.editTitle') : t('webhooks.newTitle')}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Input
                  label={t('common.name')}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full"
                  placeholder="prod-budget-alerts"
                />
              </div>
              <div>
                <Input
                  label={t('webhooks.endpointUrl')}
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  className="w-full"
                  placeholder={
                    form.channel === 'email'
                      ? 'ops@example.com'
                      : 'https://hooks.example.com/cloudatlas'
                  }
                />
                {form.channel === 'email' && (
                  <p className="text-xs text-muted mt-1">{t('webhooks.emailHint')}</p>
                )}
              </div>
              <div>
                <SelectField
                  label={t('webhooks.colChannel')}
                  value={form.channel}
                  onValueChange={value => setForm({ ...form, channel: value })}
                  className="w-full"
                  items={CHANNEL_OPTIONS.map((c) => ({ value: c.value, label: t(c.label) }))}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-2">{t('webhooks.colEvents')}</label>
                <div className="space-y-2">
                  {EVENT_OPTIONS.map((ev) => (
                    <label key={ev} className="flex items-center gap-2 text-sm text-secondary cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.events.includes(ev)}
                        onChange={() => toggleEvent(ev)}
                        className="rounded border-strong bg-subtle text-accent focus:ring-accent"
                      />
                      {ev}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <Input label={<>{t('webhooks.secret')} {editingId && <span className="text-muted">{t('webhooks.secretKeepCurrent')}</span>}</>}
                  type="password"
                  value={form.secret}
                  onChange={(e) => setForm({ ...form, secret: e.target.value })}
                  className="w-full"
                  placeholder={t('webhooks.secretPlaceholder')}
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
                  onClick={closeModal}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={createMutation.isPending || updateMutation.isPending}
                >
                  {editingId ? t('webhooks.saveChanges') : t('webhooks.createWebhook')}
                </Button>
              </div>
            </form>
          </div>
        </NativeDialog>
      )}
    </div>
  )
}
