import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'

interface Booking {
  id: string
  booked_by: string
  booked_by_name: string
  start_time: string
  end_time: string
  status: string
  notes?: string
}

interface Environment {
  id: string
  name: string
  description?: string
  status: 'available' | 'booked' | 'maintenance' | 'archived'
  auto_release_hours: number
  booking?: Booking | null
  cloud_account_id?: string
  created_at: string
}

const statusColors: Record<string, string> = {
  available:   'bg-success/10 text-success border-success/25',
  booked:      'bg-warning/10 text-warning border-warning/25',
  maintenance: 'bg-warning/10 text-warning border-warning/25',
  archived:    'bg-subtle text-muted border-strong',
}

function minutesUntil(iso: string, t: TFunction) {
  const diff = Math.round((new Date(iso).getTime() - Date.now()) / 60000)
  if (diff <= 0) return t('sharedEnvironments.overdue')
  if (diff < 60) return t('sharedEnvironments.durationMinutes', { n: diff })
  return t('sharedEnvironments.durationHoursMinutes', { h: Math.floor(diff / 60), m: diff % 60 })
}

export default function SharedEnvironments() {
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id ?? ''
  const qc = useQueryClient()

  const [showCreate, setShowCreate] = useState(false)
  const [bookingEnv, setBookingEnv] = useState<Environment | null>(null)

  // Create form state
  const [form, setForm] = useState({ name: '', description: '', auto_release_hours: 8 })
  const [bookForm, setBookForm] = useState({ start_time: '', end_time: '', notes: '' })

  const { data, isLoading } = useQuery({
    queryKey: ['shared-envs', orgId],
    queryFn: () => api.get<{ data: Environment[] }>(`/orgs/${orgId}/shared-environments`).then(r => r.data.data ?? []),
    enabled: !!orgId,
    refetchInterval: 30000,
  })

  const createEnv = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/shared-environments`, {
      name: form.name,
      description: form.description || undefined,
      auto_release_hours: form.auto_release_hours,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['shared-envs', orgId] }); setShowCreate(false); setForm({ name: '', description: '', auto_release_hours: 8 }) },
  })

  const bookEnv = useMutation({
    mutationFn: (envId: string) => api.post(`/orgs/${orgId}/shared-environments/${envId}/book`, {
      start_time: new Date(bookForm.start_time).toISOString(),
      end_time: new Date(bookForm.end_time).toISOString(),
      notes: bookForm.notes || undefined,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['shared-envs', orgId] }); setBookingEnv(null) },
  })

  const releaseEnv = useMutation({
    mutationFn: (envId: string) => api.post(`/orgs/${orgId}/shared-environments/${envId}/release`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shared-envs', orgId] }),
  })

  const deleteEnv = useMutation({
    mutationFn: (envId: string) => api.delete(`/orgs/${orgId}/shared-environments/${envId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shared-envs', orgId] }),
  })

  const envs = data ?? []
  const available = envs.filter(e => e.status === 'available').length
  const booked = envs.filter(e => e.status === 'booked').length

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-title">{t('sharedEnvironments.title')}</h1>
          <p className="text-sm text-secondary mt-1">{t('sharedEnvironments.subtitle')}</p>
        </div>
        <button onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-accent text-on-accent rounded-lg text-sm font-medium hover:bg-accent-hover">
          {t('sharedEnvironments.newEnvironment')}
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-surface rounded-xl border border-strong p-5">
          <p className="text-xs text-secondary uppercase tracking-wider">{t('sharedEnvironments.total')}</p>
          <p className="text-2xl font-bold text-primary mt-1">{envs.length}</p>
        </div>
        <div className="bg-surface rounded-xl border border-strong p-5">
          <p className="text-xs text-secondary uppercase tracking-wider">{t('sharedEnvironments.available')}</p>
          <p className="text-2xl font-bold text-success mt-1">{available}</p>
        </div>
        <div className="bg-surface rounded-xl border border-strong p-5">
          <p className="text-xs text-secondary uppercase tracking-wider">{t('sharedEnvironments.booked')}</p>
          <p className="text-2xl font-bold text-warning mt-1">{booked}</p>
        </div>
      </div>

      {/* Environment Cards */}
      {isLoading ? (
        <div className="text-center py-16 text-muted">{t('sharedEnvironments.loading')}</div>
      ) : envs.length === 0 ? (
        <div className="text-center py-16 text-muted">
          {t('sharedEnvironments.noEnvironments')}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {envs.map(env => (
            <div key={env.id} className="bg-surface rounded-xl border border-strong p-5 flex flex-col gap-4">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-primary">{env.name}</h3>
                  {env.description && <p className="text-xs text-secondary mt-1">{env.description}</p>}
                </div>
                <span className={`text-xs px-2 py-1 rounded-full border font-medium ${statusColors[env.status] ?? statusColors.archived}`}>
                  {t(`sharedEnvironments.status.${env.status}`, { defaultValue: env.status })}
                </span>
              </div>

              {env.booking && (
                <div className="bg-warning/10 border border-warning/25 rounded-lg p-3 text-xs space-y-1">
                  <p className="text-warning font-medium">{t('sharedEnvironments.bookedBy', { name: env.booking.booked_by_name ?? t('sharedEnvironments.someone') })}</p>
                  <p className="text-secondary">{t('sharedEnvironments.until', { time: new Date(env.booking.end_time).toLocaleString() })}</p>
                  <p className="text-warning font-semibold">{t('sharedEnvironments.releasesIn', { time: minutesUntil(env.booking.end_time, t) })}</p>
                  {env.booking.notes && <p className="text-secondary">"{env.booking.notes}"</p>}
                </div>
              )}

              <div className="flex gap-2 mt-auto">
                {env.status === 'available' && (
                  <button onClick={() => setBookingEnv(env)}
                    className="flex-1 text-xs py-1.5 bg-accent hover:bg-accent-hover text-on-accent rounded-md font-medium">
                    {t('sharedEnvironments.book')}
                  </button>
                )}
                {env.status === 'booked' && (
                  <button onClick={() => releaseEnv.mutate(env.id)}
                    disabled={releaseEnv.isPending}
                    className="flex-1 text-xs py-1.5 bg-emphasis hover:bg-emphasis text-primary rounded-md font-medium disabled:opacity-50">
                    {t('sharedEnvironments.release')}
                  </button>
                )}
                <button onClick={() => { if (confirm(t('sharedEnvironments.confirmDelete'))) deleteEnv.mutate(env.id) }}
                  className="px-2 py-1.5 text-xs bg-danger/10 hover:bg-danger/10 text-danger rounded-md">
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Environment Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-surface rounded-2xl border border-strong p-6 w-full max-w-md space-y-4">
            <h2 className="text-lg font-bold text-primary">{t('sharedEnvironments.newEnvironmentTitle')}</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-secondary mb-1">{t('common.name')} *</label>
                <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  className="w-full bg-subtle border border-strong rounded-lg px-3 py-2 text-sm text-primary"
                  placeholder={t('sharedEnvironments.namePlaceholder')} />
              </div>
              <div>
                <label className="block text-xs text-secondary mb-1">{t('common.description')}</label>
                <textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                  className="w-full bg-subtle border border-strong rounded-lg px-3 py-2 text-sm text-primary resize-none"
                  rows={2} placeholder={t('sharedEnvironments.descPlaceholder')} />
              </div>
              <div>
                <label className="block text-xs text-secondary mb-1">{t('sharedEnvironments.autoReleaseLabel')}</label>
                <input type="number" min={1} max={72} value={form.auto_release_hours}
                  onChange={e => setForm(p => ({ ...p, auto_release_hours: parseInt(e.target.value) || 8 }))}
                  className="w-full bg-subtle border border-strong rounded-lg px-3 py-2 text-sm text-primary" />
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={() => setShowCreate(false)}
                className="flex-1 py-2 text-sm bg-emphasis text-secondary rounded-lg hover:bg-emphasis">
                {t('common.cancel')}
              </button>
              <button onClick={() => createEnv.mutate()}
                disabled={createEnv.isPending || !form.name.trim()}
                className="flex-1 py-2 text-sm bg-accent text-on-accent rounded-lg hover:bg-accent-hover disabled:opacity-50">
                {createEnv.isPending ? t('sharedEnvironments.creating') : t('sharedEnvironments.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Book Environment Modal */}
      {bookingEnv && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-surface rounded-2xl border border-strong p-6 w-full max-w-md space-y-4">
            <h2 className="text-lg font-bold text-primary">{t('sharedEnvironments.bookTitle', { name: bookingEnv.name })}</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-secondary mb-1">{t('sharedEnvironments.startTime')} *</label>
                <input type="datetime-local" value={bookForm.start_time}
                  onChange={e => setBookForm(p => ({ ...p, start_time: e.target.value }))}
                  className="w-full bg-subtle border border-strong rounded-lg px-3 py-2 text-sm text-primary" />
              </div>
              <div>
                <label className="block text-xs text-secondary mb-1">{t('sharedEnvironments.endTime')} *</label>
                <input type="datetime-local" value={bookForm.end_time}
                  onChange={e => setBookForm(p => ({ ...p, end_time: e.target.value }))}
                  className="w-full bg-subtle border border-strong rounded-lg px-3 py-2 text-sm text-primary" />
              </div>
              <div>
                <label className="block text-xs text-secondary mb-1">{t('sharedEnvironments.notes')}</label>
                <input value={bookForm.notes} onChange={e => setBookForm(p => ({ ...p, notes: e.target.value }))}
                  className="w-full bg-subtle border border-strong rounded-lg px-3 py-2 text-sm text-primary"
                  placeholder={t('sharedEnvironments.notesPlaceholder')} />
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={() => setBookingEnv(null)}
                className="flex-1 py-2 text-sm bg-emphasis text-secondary rounded-lg hover:bg-emphasis">
                {t('common.cancel')}
              </button>
              <button onClick={() => bookEnv.mutate(bookingEnv.id)}
                disabled={bookEnv.isPending || !bookForm.start_time || !bookForm.end_time}
                className="flex-1 py-2 text-sm bg-accent text-on-accent rounded-lg hover:bg-accent-hover disabled:opacity-50">
                {bookEnv.isPending ? t('sharedEnvironments.booking') : t('sharedEnvironments.bookNow')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
