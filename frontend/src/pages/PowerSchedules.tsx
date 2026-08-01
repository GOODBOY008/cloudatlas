import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import type { PowerSchedule, PowerScheduleTrigger } from '../types'

interface ScheduleForm {
  name: string
  timezone: string
  resource_filter: string
  is_active: boolean
}

interface TriggerForm {
  cron_expression: string
  action: 'start' | 'stop'
}

const DEFAULT_SCHEDULE_FORM: ScheduleForm = {
  name: '',
  timezone: 'UTC',
  resource_filter: '',
  is_active: true,
}

const DEFAULT_TRIGGER_FORM: TriggerForm = {
  cron_expression: '0 22 * * 1-5',
  action: 'stop',
}

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Australia/Sydney',
]

function CronHint({ expr }: { expr: string }) {
  const { t } = useTranslation()
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return <span className="text-xs text-gray-500">{t('powerSchedules.cronRequired')}</span>
  return <span className="text-xs text-gray-500">{t('powerSchedules.cronExample')}</span>
}

function TriggerRow({
  trigger,
  onDelete,
  isDeleting,
}: {
  trigger: PowerScheduleTrigger
  onDelete: () => void
  isDeleting: boolean
}) {
  const { t } = useTranslation()
  return (
    <tr className="border-b border-gray-700 last:border-0 hover:bg-gray-800/40 transition-colors">
      <td className="px-4 py-2 font-mono text-sm text-gray-300">{trigger.cron_expression}</td>
      <td className="px-4 py-2">
        <span
          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
            trigger.action === 'stop'
              ? 'bg-red-900/40 text-red-300'
              : 'bg-green-900/40 text-green-300'
          }`}
        >
          {t(`status.${trigger.action}`, { defaultValue: trigger.action })}
        </span>
      </td>
      <td className="px-4 py-2 text-xs text-gray-500">
        {trigger.last_run_at ? new Date(trigger.last_run_at).toLocaleString() : t('common.never')}
      </td>
      <td className="px-4 py-2 text-xs text-gray-500">{trigger.next_run_at ? new Date(trigger.next_run_at).toLocaleString() : '—'}</td>
      <td className="px-4 py-2">
        <button
          onClick={onDelete}
          disabled={isDeleting}
          className="text-red-400 hover:text-red-300 text-xs disabled:opacity-50"
        >
          {t('common.delete')}
        </button>
      </td>
    </tr>
  )
}

export default function PowerSchedules() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const [showScheduleModal, setShowScheduleModal] = useState(false)
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null)
  const [scheduleForm, setScheduleForm] = useState<ScheduleForm>(DEFAULT_SCHEDULE_FORM)
  const [scheduleFormError, setScheduleFormError] = useState('')

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [triggerForm, setTriggerForm] = useState<TriggerForm>(DEFAULT_TRIGGER_FORM)
  const [triggerFormError, setTriggerFormError] = useState('')

  const { data: schedules = [], isLoading, isError } = useQuery<PowerSchedule[]>({
    queryKey: ['power-schedules', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: PowerSchedule[] }>(
        `/orgs/${orgId}/power-schedules`
      )
      return res.data ?? []
    },
  })

  const { data: triggers = [] } = useQuery<PowerScheduleTrigger[]>({
    queryKey: ['power-schedule-triggers', orgId, expandedId],
    enabled: !!orgId && !!expandedId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: PowerScheduleTrigger[] }>(
        `/orgs/${orgId}/power-schedules/${expandedId}/triggers`
      )
      return res.data ?? []
    },
  })

  const createScheduleMutation = useMutation({
    mutationFn: (payload: ScheduleForm) =>
      api.post(`/orgs/${orgId}/power-schedules`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['power-schedules', orgId] })
      closeScheduleModal()
    },
    onError: () => setScheduleFormError(t('powerSchedules.createFailed')),
  })

  const updateScheduleMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: ScheduleForm }) =>
      api.put(`/orgs/${orgId}/power-schedules/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['power-schedules', orgId] })
      closeScheduleModal()
    },
    onError: () => setScheduleFormError(t('powerSchedules.updateFailed')),
  })

  const deleteScheduleMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/power-schedules/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['power-schedules', orgId] }),
  })

  const toggleScheduleMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      api.put(`/orgs/${orgId}/power-schedules/${id}`, { is_active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['power-schedules', orgId] }),
  })

  const createTriggerMutation = useMutation({
    mutationFn: (payload: TriggerForm) =>
      api.post(`/orgs/${orgId}/power-schedules/${expandedId}/triggers`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['power-schedule-triggers', orgId, expandedId] })
      setTriggerForm(DEFAULT_TRIGGER_FORM)
      setTriggerFormError('')
    },
    onError: () => setTriggerFormError(t('powerSchedules.triggerAddFailed')),
  })

  const deleteTriggerMutation = useMutation({
    mutationFn: ({ scheduleId, triggerId }: { scheduleId: string; triggerId: string }) =>
      api.delete(`/orgs/${orgId}/power-schedules/${scheduleId}/triggers/${triggerId}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['power-schedule-triggers', orgId, expandedId] }),
  })

  function openCreate() {
    setEditingScheduleId(null)
    setScheduleForm(DEFAULT_SCHEDULE_FORM)
    setScheduleFormError('')
    setShowScheduleModal(true)
  }

  function openEdit(s: PowerSchedule) {
    setEditingScheduleId(s.id)
    setScheduleForm({
      name: s.name,
      timezone: s.timezone,
      resource_filter: s.resource_filter ?? '',
      is_active: s.is_active,
    })
    setScheduleFormError('')
    setShowScheduleModal(true)
  }

  function closeScheduleModal() {
    setShowScheduleModal(false)
    setEditingScheduleId(null)
    setScheduleFormError('')
  }

  function handleScheduleSubmit(e: FormEvent) {
    e.preventDefault()
    setScheduleFormError('')
    if (editingScheduleId) {
      updateScheduleMutation.mutate({ id: editingScheduleId, payload: scheduleForm })
    } else {
      createScheduleMutation.mutate(scheduleForm)
    }
  }

  function handleTriggerSubmit(e: FormEvent) {
    e.preventDefault()
    setTriggerFormError('')
    createTriggerMutation.mutate(triggerForm)
  }

  function toggleExpand(id: string) {
    setExpandedId((prev) => (prev === id ? null : id))
    setTriggerForm(DEFAULT_TRIGGER_FORM)
    setTriggerFormError('')
  }

  const inputCls =
    'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-500'

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">{t('powerSchedules.title')}</h2>
        <button
          onClick={openCreate}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {t('powerSchedules.newSchedule')}
        </button>
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
          {t('powerSchedules.loadFailed')}
        </div>
      )}

      {isLoading ? (
        <div className="text-gray-500 text-sm">{t('common.loading')}</div>
      ) : schedules.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-8 text-center text-gray-500 text-sm">
          {t('powerSchedules.noSchedules')}
        </div>
      ) : (
        <div className="space-y-3">
          {schedules.map((schedule) => (
            <div key={schedule.id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              {/* Schedule row */}
              <div className="flex items-center justify-between px-5 py-4">
                <div className="flex items-center gap-4">
                  <div>
                    <p className="font-medium text-white">{schedule.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {schedule.timezone}
                      {schedule.resource_filter ? t('powerSchedules.filterSuffix', { filter: schedule.resource_filter }) : ''}
                    </p>
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      schedule.is_active
                        ? 'bg-green-900/40 text-green-300'
                        : 'bg-gray-700 text-gray-400'
                    }`}
                  >
                    {schedule.is_active ? t('common.active') : t('common.inactive')}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => toggleScheduleMutation.mutate({ id: schedule.id, is_active: !schedule.is_active })}
                    className={`text-xs ${schedule.is_active ? 'text-yellow-300 hover:text-yellow-200' : 'text-green-300 hover:text-green-200'}`}
                  >
                    {schedule.is_active ? t('powerSchedules.deactivate') : t('powerSchedules.activate')}
                  </button>
                  <button
                    onClick={() => toggleExpand(schedule.id)}
                    className="text-indigo-400 hover:text-indigo-300 text-xs"
                  >
                    {expandedId === schedule.id ? t('powerSchedules.hideTriggers') : t('powerSchedules.triggersToggle')}
                  </button>
                  <button
                    onClick={() => openEdit(schedule)}
                    className="text-gray-400 hover:text-white text-xs"
                  >
                    {t('common.edit')}
                  </button>
                  <button
                    onClick={() => deleteScheduleMutation.mutate(schedule.id)}
                    disabled={deleteScheduleMutation.isPending}
                    className="text-red-400 hover:text-red-300 text-xs disabled:opacity-50"
                  >
                    {t('common.delete')}
                  </button>
                </div>
              </div>

              {/* Expanded triggers */}
              {expandedId === schedule.id && (
                <div className="border-t border-gray-800 px-5 py-4 bg-gray-950/50">
                  <h4 className="text-xs font-semibold text-gray-400 uppercase mb-3">{t('powerSchedules.triggers')}</h4>

                  {triggers.length > 0 ? (
                    <table className="w-full text-sm mb-4">
                      <thead>
                        <tr className="text-gray-500 text-xs text-left">
                          <th className="pb-2 font-medium">{t('powerSchedules.cronExpression')}</th>
                          <th className="pb-2 font-medium">{t('powerSchedules.action')}</th>
                          <th className="pb-2 font-medium">{t('powerSchedules.lastRun')}</th>
                          <th className="pb-2 font-medium">{t('powerSchedules.nextRun')}</th>
                          <th className="pb-2 font-medium"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {triggers.map((t) => (
                          <TriggerRow
                            key={t.id}
                            trigger={t}
                            onDelete={() =>
                              deleteTriggerMutation.mutate({
                                scheduleId: schedule.id,
                                triggerId: t.id,
                              })
                            }
                            isDeleting={deleteTriggerMutation.isPending}
                          />
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-xs text-gray-600 mb-4">{t('powerSchedules.noTriggers')}</p>
                  )}

                  {/* Add trigger form */}
                  <form onSubmit={handleTriggerSubmit} className="flex items-end gap-3 flex-wrap">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('powerSchedules.cronExpression')}</label>
                      <input
                        required
                        value={triggerForm.cron_expression}
                        onChange={(e) =>
                          setTriggerForm({ ...triggerForm, cron_expression: e.target.value })
                        }
                        className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm font-mono w-44 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="0 22 * * 1-5"
                      />
                      <div className="mt-1">
                        <CronHint expr={triggerForm.cron_expression} />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('powerSchedules.action')}</label>
                      <select
                        value={triggerForm.action}
                        onChange={(e) =>
                          setTriggerForm({
                            ...triggerForm,
                            action: e.target.value as 'start' | 'stop',
                          })
                        }
                        className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      >
                        <option value="stop">{t('powerSchedules.actionStop')}</option>
                        <option value="start">{t('powerSchedules.actionStart')}</option>
                      </select>
                    </div>
                    <button
                      type="submit"
                      disabled={createTriggerMutation.isPending}
                      className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm rounded-lg transition-colors"
                    >
                      {createTriggerMutation.isPending ? t('powerSchedules.adding') : t('powerSchedules.addTrigger')}
                    </button>
                    {triggerFormError && (
                      <span className="text-red-400 text-xs">{triggerFormError}</span>
                    )}
                  </form>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Schedule Create/Edit Modal */}
      {showScheduleModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-900 rounded-xl p-6 w-full max-w-lg border border-gray-800 shadow-xl">
            <h3 className="text-base font-semibold text-white mb-4">
              {editingScheduleId ? t('powerSchedules.editSchedule') : t('powerSchedules.newScheduleTitle')}
            </h3>
            {scheduleFormError && (
              <div className="mb-3 p-2 rounded bg-red-900/40 border border-red-700 text-red-300 text-sm">
                {scheduleFormError}
              </div>
            )}
            <form onSubmit={handleScheduleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('common.name')}</label>
                <input
                  required
                  value={scheduleForm.name}
                  onChange={(e) => setScheduleForm({ ...scheduleForm, name: e.target.value })}
                  className={inputCls}
                  placeholder={t('powerSchedules.namePlaceholder')}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('powerSchedules.timezone')}</label>
                <select
                  value={scheduleForm.timezone}
                  onChange={(e) =>
                    setScheduleForm({ ...scheduleForm, timezone: e.target.value })
                  }
                  className={inputCls}
                >
                  {COMMON_TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  {t('powerSchedules.resourceFilter')}{' '}
                  <span className="text-gray-600">{t('powerSchedules.resourceFilterOptional')}</span>
                </label>
                <input
                  value={scheduleForm.resource_filter}
                  onChange={(e) =>
                    setScheduleForm({ ...scheduleForm, resource_filter: e.target.value })
                  }
                  className={inputCls}
                  placeholder="tag:env=dev"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="sched-is-active"
                  checked={scheduleForm.is_active}
                  onChange={(e) =>
                    setScheduleForm({ ...scheduleForm, is_active: e.target.checked })
                  }
                  className="w-4 h-4 rounded border-gray-700 accent-indigo-600"
                />
                <label htmlFor="sched-is-active" className="text-sm text-gray-300">
                  {t('common.active')}
                </label>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeScheduleModal}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createScheduleMutation.isPending || updateScheduleMutation.isPending}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  {createScheduleMutation.isPending || updateScheduleMutation.isPending
                    ? t('powerSchedules.saving')
                    : editingScheduleId
                    ? t('powerSchedules.updateSchedule')
                    : t('powerSchedules.createSchedule')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
