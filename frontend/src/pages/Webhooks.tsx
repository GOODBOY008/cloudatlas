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
      ? 'bg-green-900/40 text-green-300'
      : channel === 'teams'
        ? 'bg-purple-900/40 text-purple-300'
        : channel === 'pagerduty'
          ? 'bg-orange-900/40 text-orange-300'
          : channel === 'email'
            ? 'bg-blue-900/40 text-blue-300'
            : 'bg-gray-800 text-gray-400'
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>{channel}</span>
}

function EventBadge({ event }: { event: string }) {
  const color =
    event === 'budget.exceeded'
      ? 'bg-red-900/40 text-red-300'
      : event === 'anomaly.detected'
        ? 'bg-yellow-900/40 text-yellow-300'
        : event === 'recommendation.created'
          ? 'bg-green-900/40 text-green-300'
          : 'bg-blue-900/40 text-blue-300'
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
      ? 'bg-green-900/40 text-green-300'
      : status === 'failed'
        ? 'bg-red-900/40 text-red-300'
        : status === 'pending'
          ? 'bg-yellow-900/40 text-yellow-300'
          : 'bg-gray-800 text-gray-400'
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

  const inputCls =
    'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-500'

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">{t('webhooks.title')}</h2>
        <button
          onClick={openCreate}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {t('webhooks.newWebhook')}
        </button>
      </div>

      <div className="flex gap-1 mb-4 border-b border-gray-800">
        {(['webhooks', 'events'] as const).map((tabKey) => (
          <button
            key={tabKey}
            onClick={() => setTab(tabKey)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === tabKey
                ? 'border-indigo-500 text-white'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {tabKey === 'webhooks' ? t('webhooks.tabEndpoints') : t('webhooks.tabDeliveryLog')}
          </button>
        ))}
      </div>

      {tab === 'webhooks' ? (
        <>
          {isError && (
            <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
              {t('webhooks.loadFailed')}
            </div>
          )}

          {isLoading ? (
            <div className="text-gray-500 text-sm">{t('common.loading')}</div>
          ) : webhooks.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-8 text-center text-gray-500 text-sm">
              {t('webhooks.empty')}
            </div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <table className="w-full text-left">
                <thead className="border-b border-gray-800 text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">{t('common.name')}</th>
                    <th className="px-4 py-3 font-medium">{t('webhooks.colUrl')}</th>
                    <th className="px-4 py-3 font-medium">{t('webhooks.colChannel')}</th>
                    <th className="px-4 py-3 font-medium">{t('webhooks.colEvents')}</th>
                    <th className="px-4 py-3 font-medium">{t('common.status')}</th>
                    <th className="px-4 py-3 font-medium">{t('webhooks.colLastDelivery')}</th>
                    <th className="px-4 py-3 font-medium">{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {webhooks.map((hook) => (
                    <tr key={hook.id} className="border-b border-gray-700 last:border-0 hover:bg-gray-800/40 transition-colors">
                      <td className="px-4 py-3 text-sm text-white">{hook.name}</td>
                      <td className="px-4 py-3 text-sm font-mono text-gray-400 max-w-[240px] truncate">{hook.url}</td>
                      <td className="px-4 py-3">
                        <ChannelBadge channel={hook.channel ?? 'generic'} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {hook.events.map((ev) => (
                            <EventBadge key={ev} event={ev} />
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() =>
                            toggleMutation.mutate({ id: hook.id, is_active: !hook.is_active })
                          }
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                            hook.is_active ? 'bg-green-600' : 'bg-gray-700'
                          }`}
                          title={hook.is_active ? t('webhooks.toggleDeactivate') : t('webhooks.toggleActivate')}
                        >
                          <span
                            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                              hook.is_active ? 'translate-x-[18px]' : 'translate-x-[3px]'
                            }`}
                          />
                        </button>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {hook.last_triggered_at ? (
                          <>
                            <div>{new Date(hook.last_triggered_at).toLocaleString()}</div>
                            {hook.last_status !== null && (
                              <div className="mt-0.5 font-mono text-gray-400">HTTP {hook.last_status}</div>
                            )}
                          </>
                        ) : (
                          t('common.never')
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3 text-xs">
                          <button
                            onClick={() => openEdit(hook)}
                            className="text-indigo-400 hover:text-indigo-300"
                          >
                            {t('common.edit')}
                          </button>
                          <button
                            onClick={() => {
                              if (confirm(t('webhooks.deleteConfirm', { name: hook.name }))) {
                                deleteMutation.mutate(hook.id)
                              }
                            }}
                            className="text-red-400 hover:text-red-300"
                          >
                            {t('common.delete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
            <div className="text-gray-500 text-sm">{t('common.loading')}</div>
          ) : events.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-8 text-center text-gray-500 text-sm">
              {t('webhooks.noEvents')}
            </div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <table className="w-full text-left">
                <thead className="border-b border-gray-800 text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">{t('webhooks.colWebhook')}</th>
                    <th className="px-4 py-3 font-medium">{t('webhooks.colEvent')}</th>
                    <th className="px-4 py-3 font-medium">{t('common.status')}</th>
                    <th className="px-4 py-3 font-medium">{t('webhooks.colAttempts')}</th>
                    <th className="px-4 py-3 font-medium">{t('webhooks.colResponse')}</th>
                    <th className="px-4 py-3 font-medium">{t('common.created')}</th>
                    <th className="px-4 py-3 font-medium">{t('webhooks.colDelivered')}</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev) => (
                    <tr key={ev.id} className="border-b border-gray-700 last:border-0 hover:bg-gray-800/40 transition-colors">
                      <td className="px-4 py-3 text-sm text-white">{ev.webhook_name}</td>
                      <td className="px-4 py-3">
                        <EventBadge event={ev.event_type} />
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={ev.status} />
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-400">{ev.attempts}</td>
                      <td className="px-4 py-3 text-sm font-mono text-gray-400">
                        {ev.response_status ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {new Date(ev.created_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {ev.delivered_at ? new Date(ev.delivered_at).toLocaleString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={closeModal}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-lg shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-4">
              {editingId ? t('webhooks.editTitle') : t('webhooks.newTitle')}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">{t('common.name')}</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className={inputCls}
                  placeholder="prod-budget-alerts"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">{t('webhooks.endpointUrl')}</label>
                <input
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  className={inputCls}
                  placeholder={
                    form.channel === 'email'
                      ? 'ops@example.com'
                      : 'https://hooks.example.com/cloudatlas'
                  }
                />
                {form.channel === 'email' && (
                  <p className="text-xs text-gray-600 mt-1">{t('webhooks.emailHint')}</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">{t('webhooks.colChannel')}</label>
                <select
                  value={form.channel}
                  onChange={(e) => setForm({ ...form, channel: e.target.value })}
                  className={inputCls}
                >
                  {CHANNEL_OPTIONS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {t(c.label)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-2">{t('webhooks.colEvents')}</label>
                <div className="space-y-2">
                  {EVENT_OPTIONS.map((ev) => (
                    <label key={ev} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.events.includes(ev)}
                        onChange={() => toggleEvent(ev)}
                        className="rounded border-gray-600 bg-gray-800 text-indigo-500 focus:ring-indigo-500"
                      />
                      {ev}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">
                  {t('webhooks.secret')} {editingId && <span className="text-gray-600">{t('webhooks.secretKeepCurrent')}</span>}
                </label>
                <input
                  type="password"
                  value={form.secret}
                  onChange={(e) => setForm({ ...form, secret: e.target.value })}
                  className={inputCls}
                  placeholder={t('webhooks.secretPlaceholder')}
                />
              </div>
              {formError && (
                <div className="p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-400 text-sm">
                  {formError}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending || updateMutation.isPending}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                >
                  {editingId ? t('webhooks.saveChanges') : t('webhooks.createWebhook')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
