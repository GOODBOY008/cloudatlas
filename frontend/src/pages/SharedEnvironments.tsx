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
  available:   'bg-green-900/50 text-green-300 border-green-700',
  booked:      'bg-yellow-900/50 text-yellow-300 border-yellow-700',
  maintenance: 'bg-orange-900/50 text-orange-300 border-orange-700',
  archived:    'bg-gray-800 text-gray-500 border-gray-600',
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
          <h1 className="text-2xl font-bold text-white">{t('sharedEnvironments.title')}</h1>
          <p className="text-sm text-gray-400 mt-1">{t('sharedEnvironments.subtitle')}</p>
        </div>
        <button onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-500">
          {t('sharedEnvironments.newEnvironment')}
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-gray-900 rounded-xl border border-gray-700 p-5">
          <p className="text-xs text-gray-400 uppercase tracking-wider">{t('sharedEnvironments.total')}</p>
          <p className="text-2xl font-bold text-white mt-1">{envs.length}</p>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-700 p-5">
          <p className="text-xs text-gray-400 uppercase tracking-wider">{t('sharedEnvironments.available')}</p>
          <p className="text-2xl font-bold text-green-400 mt-1">{available}</p>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-700 p-5">
          <p className="text-xs text-gray-400 uppercase tracking-wider">{t('sharedEnvironments.booked')}</p>
          <p className="text-2xl font-bold text-yellow-400 mt-1">{booked}</p>
        </div>
      </div>

      {/* Environment Cards */}
      {isLoading ? (
        <div className="text-center py-16 text-gray-500">{t('sharedEnvironments.loading')}</div>
      ) : envs.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          {t('sharedEnvironments.noEnvironments')}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {envs.map(env => (
            <div key={env.id} className="bg-gray-900 rounded-xl border border-gray-700 p-5 flex flex-col gap-4">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-white">{env.name}</h3>
                  {env.description && <p className="text-xs text-gray-400 mt-1">{env.description}</p>}
                </div>
                <span className={`text-xs px-2 py-1 rounded-full border font-medium ${statusColors[env.status] ?? statusColors.archived}`}>
                  {t(`sharedEnvironments.status.${env.status}`, { defaultValue: env.status })}
                </span>
              </div>

              {env.booking && (
                <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-lg p-3 text-xs space-y-1">
                  <p className="text-yellow-300 font-medium">{t('sharedEnvironments.bookedBy', { name: env.booking.booked_by_name ?? t('sharedEnvironments.someone') })}</p>
                  <p className="text-gray-400">{t('sharedEnvironments.until', { time: new Date(env.booking.end_time).toLocaleString() })}</p>
                  <p className="text-yellow-400 font-semibold">{t('sharedEnvironments.releasesIn', { time: minutesUntil(env.booking.end_time, t) })}</p>
                  {env.booking.notes && <p className="text-gray-300">"{env.booking.notes}"</p>}
                </div>
              )}

              <div className="flex gap-2 mt-auto">
                {env.status === 'available' && (
                  <button onClick={() => setBookingEnv(env)}
                    className="flex-1 text-xs py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md font-medium">
                    {t('sharedEnvironments.book')}
                  </button>
                )}
                {env.status === 'booked' && (
                  <button onClick={() => releaseEnv.mutate(env.id)}
                    disabled={releaseEnv.isPending}
                    className="flex-1 text-xs py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-md font-medium disabled:opacity-50">
                    {t('sharedEnvironments.release')}
                  </button>
                )}
                <button onClick={() => { if (confirm(t('sharedEnvironments.confirmDelete'))) deleteEnv.mutate(env.id) }}
                  className="px-2 py-1.5 text-xs bg-red-900/40 hover:bg-red-800/60 text-red-300 rounded-md">
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
          <div className="bg-gray-900 rounded-2xl border border-gray-700 p-6 w-full max-w-md space-y-4">
            <h2 className="text-lg font-bold text-white">{t('sharedEnvironments.newEnvironmentTitle')}</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('common.name')} *</label>
                <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white"
                  placeholder={t('sharedEnvironments.namePlaceholder')} />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('common.description')}</label>
                <textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white resize-none"
                  rows={2} placeholder={t('sharedEnvironments.descPlaceholder')} />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('sharedEnvironments.autoReleaseLabel')}</label>
                <input type="number" min={1} max={72} value={form.auto_release_hours}
                  onChange={e => setForm(p => ({ ...p, auto_release_hours: parseInt(e.target.value) || 8 }))}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white" />
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={() => setShowCreate(false)}
                className="flex-1 py-2 text-sm bg-gray-700 text-gray-300 rounded-lg hover:bg-gray-600">
                {t('common.cancel')}
              </button>
              <button onClick={() => createEnv.mutate()}
                disabled={createEnv.isPending || !form.name.trim()}
                className="flex-1 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-50">
                {createEnv.isPending ? t('sharedEnvironments.creating') : t('sharedEnvironments.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Book Environment Modal */}
      {bookingEnv && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 rounded-2xl border border-gray-700 p-6 w-full max-w-md space-y-4">
            <h2 className="text-lg font-bold text-white">{t('sharedEnvironments.bookTitle', { name: bookingEnv.name })}</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('sharedEnvironments.startTime')} *</label>
                <input type="datetime-local" value={bookForm.start_time}
                  onChange={e => setBookForm(p => ({ ...p, start_time: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white" />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('sharedEnvironments.endTime')} *</label>
                <input type="datetime-local" value={bookForm.end_time}
                  onChange={e => setBookForm(p => ({ ...p, end_time: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white" />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('sharedEnvironments.notes')}</label>
                <input value={bookForm.notes} onChange={e => setBookForm(p => ({ ...p, notes: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white"
                  placeholder={t('sharedEnvironments.notesPlaceholder')} />
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={() => setBookingEnv(null)}
                className="flex-1 py-2 text-sm bg-gray-700 text-gray-300 rounded-lg hover:bg-gray-600">
                {t('common.cancel')}
              </button>
              <button onClick={() => bookEnv.mutate(bookingEnv.id)}
                disabled={bookEnv.isPending || !bookForm.start_time || !bookForm.end_time}
                className="flex-1 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-50">
                {bookEnv.isPending ? t('sharedEnvironments.booking') : t('sharedEnvironments.bookNow')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
