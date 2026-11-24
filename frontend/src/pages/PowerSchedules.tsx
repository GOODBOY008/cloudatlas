import { Table } from '@cloudflare/kumo/components/table'
import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { NativeDialog } from '../components/shared/NativeDialog'
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
  if (parts.length !== 5) return <span className="text-xs text-muted">{t('powerSchedules.cronRequired')}</span>
  return <span className="text-xs text-muted">{t('powerSchedules.cronExample')}</span>
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
    <Table.Row className="border-b border-strong last:border-0 hover:bg-subtle/40 transition-colors">
      <Table.Cell className="px-4 py-2 font-mono text-sm text-secondary">{trigger.cron_expression}</Table.Cell>
      <Table.Cell className="px-4 py-2">
        <span
          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
            trigger.action === 'stop'
              ? 'bg-danger/10 text-danger'
              : 'bg-success/10 text-success'
          }`}
        >
          {t(`status.${trigger.action}`, { defaultValue: trigger.action })}
        </span>
      </Table.Cell>
      <Table.Cell className="px-4 py-2 text-xs text-muted">
        {trigger.last_run_at ? new Date(trigger.last_run_at).toLocaleString() : t('common.never')}
      </Table.Cell>
      <Table.Cell className="px-4 py-2 text-xs text-muted">{trigger.next_run_at ? new Date(trigger.next_run_at).toLocaleString() : '—'}</Table.Cell>
      <Table.Cell className="px-4 py-2">
        <Button
          size="sm" variant="secondary-destructive"
          onClick={onDelete}
          disabled={isDeleting}
        >
          {t('common.delete')}
        </Button>
      </Table.Cell>
    </Table.Row>
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

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('powerSchedules.title')}</h1>
        <Button
          variant="primary"
          onClick={openCreate}
        >
          {t('powerSchedules.newSchedule')}
        </Button>
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
          {t('powerSchedules.loadFailed')}
        </div>
      )}

      {isLoading ? (
        <div className="text-muted text-sm">{t('common.loading')}</div>
      ) : schedules.length === 0 ? (
        <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
          {t('powerSchedules.noSchedules')}
        </div>
      ) : (
        <div className="space-y-3">
          {schedules.map((schedule) => (
            <div key={schedule.id} className="bg-surface border border-edge rounded-xl overflow-hidden">
              {/* Schedule row */}
              <div className="flex items-center justify-between px-5 py-4">
                <div className="flex items-center gap-4">
                  <div>
                    <p className="font-medium text-primary">{schedule.name}</p>
                    <p className="text-xs text-muted mt-0.5">
                      {schedule.timezone}
                      {schedule.resource_filter ? t('powerSchedules.filterSuffix', { filter: schedule.resource_filter }) : ''}
                    </p>
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      schedule.is_active
                        ? 'bg-success/10 text-success'
                        : 'bg-emphasis text-secondary'
                    }`}
                  >
                    {schedule.is_active ? t('common.active') : t('common.inactive')}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => toggleScheduleMutation.mutate({ id: schedule.id, is_active: !schedule.is_active })}
                    className={`text-xs ${schedule.is_active ? 'text-warning hover:text-warning' : 'text-success hover:text-success'}`}
                  >
                    {schedule.is_active ? t('powerSchedules.deactivate') : t('powerSchedules.activate')}
                  </button>
                  <button
                    onClick={() => toggleExpand(schedule.id)}
                    className="text-accent hover:text-accent text-xs"
                  >
                    {expandedId === schedule.id ? t('powerSchedules.hideTriggers') : t('powerSchedules.triggersToggle')}
                  </button>
                  <button
                    onClick={() => openEdit(schedule)}
                    className="text-secondary hover:text-primary text-xs"
                  >
                    {t('common.edit')}
                  </button>
                  <button
                    onClick={() => deleteScheduleMutation.mutate(schedule.id)}
                    disabled={deleteScheduleMutation.isPending}
                    className="text-danger hover:text-danger text-xs disabled:opacity-50"
                  >
                    {t('common.delete')}
                  </button>
                </div>
              </div>

              {/* Expanded triggers */}
              {expandedId === schedule.id && (
                <div className="border-t border-edge px-5 py-4 bg-canvas/50">
                  <h4 className="text-xs font-semibold text-secondary uppercase mb-3">{t('powerSchedules.triggers')}</h4>

                  {triggers.length > 0 ? (
                    <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table className="mb-4">
                      <Table.Header variant="compact">
                        <Table.Row className="text-muted text-xs text-left">
                          <Table.Head className="pb-2 font-medium">{t('powerSchedules.cronExpression')}</Table.Head>
                          <Table.Head className="pb-2 font-medium">{t('powerSchedules.action')}</Table.Head>
                          <Table.Head className="pb-2 font-medium">{t('powerSchedules.lastRun')}</Table.Head>
                          <Table.Head className="pb-2 font-medium">{t('powerSchedules.nextRun')}</Table.Head>
                          <Table.Head className="pb-2 font-medium"></Table.Head>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
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
                      </Table.Body>
                    </Table></div>
                  ) : (
                    <p className="text-xs text-muted mb-4">{t('powerSchedules.noTriggers')}</p>
                  )}

                  {/* Add trigger form */}
                  <form onSubmit={handleTriggerSubmit} className="flex items-end gap-3 flex-wrap">
                    <div>
                      <Input label={t('powerSchedules.cronExpression')}
                        required
                        value={triggerForm.cron_expression}
                        onChange={(e) =>
                          setTriggerForm({ ...triggerForm, cron_expression: e.target.value })
                        }
                        className="font-mono w-44"
                        placeholder="0 22 * * 1-5"
                      />
                      <div className="mt-1">
                        <CronHint expr={triggerForm.cron_expression} />
                      </div>
                    </div>
                    <div>
                      <SelectField
                        label={t('powerSchedules.action')}
                        value={triggerForm.action}
                        onValueChange={value =>
                          setTriggerForm({
                            ...triggerForm,
                            action: value as 'start' | 'stop',
                          })}
                        items={[
                          { value: "stop", label: t('powerSchedules.actionStop') },
                          { value: "start", label: t('powerSchedules.actionStart') },
                        ]}
                      />
                    </div>
                    <Button
                      variant="primary"
                      type="submit"
                      disabled={createTriggerMutation.isPending}
                    >
                      {createTriggerMutation.isPending ? t('powerSchedules.adding') : t('powerSchedules.addTrigger')}
                    </Button>
                    {triggerFormError && (
                      <span className="text-danger text-xs">{triggerFormError}</span>
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
        <NativeDialog className="items-center justify-center p-4" label={editingScheduleId ? t('powerSchedules.editSchedule') : t('powerSchedules.newScheduleTitle')} onClose={closeScheduleModal}>
          <div className="dialog-panel p-6 w-full max-w-lg">
            <h3 className="text-base font-semibold text-primary mb-4">
              {editingScheduleId ? t('powerSchedules.editSchedule') : t('powerSchedules.newScheduleTitle')}
            </h3>
            {scheduleFormError && (
              <div className="mb-3 p-2 rounded bg-danger/10 border border-danger/25 text-danger text-sm">
                {scheduleFormError}
              </div>
            )}
            <form onSubmit={handleScheduleSubmit} className="space-y-4">
              <div>
                <Input label={t('common.name')}
                  required
                  value={scheduleForm.name}
                  onChange={(e) => setScheduleForm({ ...scheduleForm, name: e.target.value })}
                  className="w-full"
                  placeholder={t('powerSchedules.namePlaceholder')}
                />
              </div>
              <div>
                <SelectField
                  label={t('powerSchedules.timezone')}
                  value={scheduleForm.timezone}
                  onValueChange={value =>
                    setScheduleForm({ ...scheduleForm, timezone: value })}
                  className="w-full"
                  items={COMMON_TIMEZONES.map((tz) => ({ value: tz, label: tz }))}
                />
              </div>
              <div>
                <Input label={<>{t('powerSchedules.resourceFilter')}{' '}
                  <span className="text-muted">{t('powerSchedules.resourceFilterOptional')}</span></>}
                  value={scheduleForm.resource_filter}
                  onChange={(e) =>
                    setScheduleForm({ ...scheduleForm, resource_filter: e.target.value })
                  }
                  className="w-full"
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
                  className="w-4 h-4 rounded border-strong"
                />
                <label htmlFor="sched-is-active" className="text-sm text-secondary">
                  {t('common.active')}
                </label>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button
                  type="button"
                  onClick={closeScheduleModal}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={createScheduleMutation.isPending || updateScheduleMutation.isPending}
                >
                  {createScheduleMutation.isPending || updateScheduleMutation.isPending
                    ? t('powerSchedules.saving')
                    : editingScheduleId
                    ? t('powerSchedules.updateSchedule')
                    : t('powerSchedules.createSchedule')}
                </Button>
              </div>
            </form>
          </div>
        </NativeDialog>
      )}
    </div>
  )
}
