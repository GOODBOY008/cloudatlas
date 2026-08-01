import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useCopilotStore } from '../store/copilotStore'
import { useTranslation } from 'react-i18next'

// ─── Types ───────────────────────────────────────────────────────────────────

interface AiSettings {
  assistant_enabled: boolean
  smart_recs_enabled: boolean
  forecast_enabled: boolean
  anomaly_enabled: boolean
  rag_enabled: boolean
}

interface ForecastPoint {
  date: string
  forecast: number
}

interface AnomalyPoint {
  date: string
  value: number
  z_score: number
  direction: string
}

interface Note {
  id: string
  title: string
  body: string
  created_at: string
}

interface SearchResult {
  id: string
  title: string
  body: string
  score: number
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function AICenter() {
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const { t } = useTranslation()

  const [tab, setTab] = useState<'assistant' | 'forecast' | 'anomalies' | 'notes' | 'settings'>('assistant')

  // Assistant

  // Forecast
  const [forecast, setForecast] = useState<{ points: ForecastPoint[]; summary?: Record<string, unknown> } | null>(null)

  // Anomalies
  const [anomalies, setAnomalies] = useState<AnomalyPoint[] | null>(null)

  // Notes
  const [noteTitle, setNoteTitle] = useState('')
  const [noteBody, setNoteBody] = useState('')
  const [noteError, setNoteError] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
  const [searchMode, setSearchMode] = useState('')

  const { data: settings, isLoading: settingsLoading } = useQuery<AiSettings>({
    queryKey: ['ai-settings', orgId],
    enabled: !!orgId && tab === 'settings',
    queryFn: async () => {
      const { data: res } = await api.get<{ data: AiSettings }>(`/orgs/${orgId}/ai/settings`)
      return res.data
    },
  })

  const { data: providerInfo } = useQuery<{ source: string }>({
    queryKey: ['ai-provider', orgId],
    enabled: !!orgId && tab === 'settings',
    staleTime: 30_000,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: { source: string } }>(`/orgs/${orgId}/ai/provider`)
      return res.data
    },
  })

  const { data: notes = [], isLoading: notesLoading } = useQuery<Note[]>({
    queryKey: ['ai-notes', orgId],
    enabled: !!orgId && tab === 'notes',
    queryFn: async () => {
      const { data: res } = await api.get<{ data: Note[] }>(`/orgs/${orgId}/ai/notes`)
      return res.data ?? []
    },
  })

  const settingsMutation = useMutation({
    mutationFn: (payload: Partial<AiSettings>) => api.put(`/orgs/${orgId}/ai/settings`, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-settings', orgId] }),
  })

  const createNoteMutation = useMutation({
    mutationFn: (payload: { title: string; body: string }) =>
      api.post(`/orgs/${orgId}/ai/notes`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-notes', orgId] })
      setNoteTitle('')
      setNoteBody('')
      setNoteError('')
    },
    onError: () => setNoteError(t('aiCenter.saveNoteFailed')),
  })

  function runForecast() {
    api
      .post<{ data: { points: ForecastPoint[]; summary?: Record<string, unknown> } }>(`/orgs/${orgId}/ai/forecast`)
      .then((res) => setForecast(res.data.data))
      .catch(() => setForecast(null))
  }

  function runAnomalies() {
    api
      .post<{ data: { anomalies: AnomalyPoint[] } }>(`/orgs/${orgId}/ai/anomalies`)
      .then((res) => setAnomalies(res.data.data.anomalies))
      .catch(() => setAnomalies([]))
  }

  function searchNotes(e: FormEvent) {
    e.preventDefault()
    if (!searchQuery.trim()) return
    api
      .post<{ data: SearchResult[]; mode: string }>(`/orgs/${orgId}/ai/notes/search`, {
        query: searchQuery.trim(),
        limit: 8,
      })
      .then((res) => {
        setSearchResults(res.data.data)
        setSearchMode(res.data.mode)
      })
      .catch(() => setSearchResults([]))
  }

  const tabLabels: Record<string, string> = {
    assistant: t('aiCenter.tabAssistant'),
    forecast: t('aiCenter.tabForecast'),
    anomalies: t('aiCenter.tabAnomalies'),
    notes: t('aiCenter.tabNotes'),
    settings: t('aiCenter.tabSettings'),
  }

  const toggleCls =
    'relative inline-flex h-5 w-9 items-center rounded-full transition-colors'
  const knobCls = 'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform'

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">{t('aiCenter.title')}</h2>
      </div>

      <div className="flex gap-1 mb-4 border-b border-gray-800 flex-wrap">
        {(['assistant', 'forecast', 'anomalies', 'notes', 'settings'] as const).map((tabKey) => (
          <button
            key={tabKey}
            onClick={() => setTab(tabKey)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === tabKey
                ? 'border-indigo-500 text-white'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {tabLabels[tabKey]}
          </button>
        ))}
      </div>

      {tab === 'assistant' && (
        <div className="max-w-xl">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-8 text-center">
            <Sparkles size={28} className="mx-auto text-indigo-500 dark:text-indigo-400 mb-3" />
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
              {t('copilot.redirectTitle')}
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">{t('copilot.redirectBody')}</p>
            <button
              onClick={() => useCopilotStore.getState().setOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Sparkles size={15} />
              {t('copilot.openCopilot')}
            </button>
          </div>
        </div>
      )}

      {tab === 'forecast' && (
        <div className="max-w-3xl space-y-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <p className="text-sm text-gray-300 mb-3">
              {t('aiCenter.forecastDesc')}
            </p>
            <button
              onClick={runForecast}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {t('aiCenter.generateForecast')}
            </button>
            {forecast?.summary && (
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div className="bg-gray-800 rounded-lg p-3">
                  <p className="text-xs text-gray-500">{t('aiCenter.historicalTotal90d')}</p>
                  <p className="text-white font-semibold">
                    ${Number(forecast.summary.historical_total).toLocaleString()}
                  </p>
                </div>
                <div className="bg-gray-800 rounded-lg p-3">
                  <p className="text-xs text-gray-500">{t('aiCenter.projectedNext14d')}</p>
                  <p className="text-white font-semibold">
                    ${Number(forecast.summary.projected_total_next_14d).toLocaleString()}
                  </p>
                </div>
              </div>
            )}
          </div>
          {forecast && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <table className="w-full text-left">
                <thead className="border-b border-gray-800 text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('aiCenter.colDate')}</th>
                    <th className="px-4 py-2 font-medium">{t('aiCenter.colForecast')}</th>
                  </tr>
                </thead>
                <tbody>
                  {forecast.points.map((p) => (
                    <tr key={p.date} className="border-b border-gray-700 last:border-0">
                      <td className="px-4 py-2 text-sm text-gray-300">{p.date}</td>
                      <td className="px-4 py-2 text-sm text-white">
                        ${p.forecast.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'anomalies' && (
        <div className="max-w-3xl space-y-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <p className="text-sm text-gray-300 mb-3">
              {t('aiCenter.anomaliesDesc')}
            </p>
            <button
              onClick={runAnomalies}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {t('aiCenter.scanForAnomalies')}
            </button>
          </div>
          {anomalies && (
            anomalies.length === 0 ? (
              <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-8 text-center text-gray-500 text-sm">
                {t('aiCenter.noAnomaliesDetected')}
              </div>
            ) : (
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <table className="w-full text-left">
                  <thead className="border-b border-gray-800 text-xs uppercase text-gray-500">
                    <tr>
                      <th className="px-4 py-2 font-medium">{t('aiCenter.colDate')}</th>
                      <th className="px-4 py-2 font-medium">{t('aiCenter.colDirection')}</th>
                      <th className="px-4 py-2 font-medium">{t('aiCenter.colValue')}</th>
                      <th className="px-4 py-2 font-medium">{t('aiCenter.colZScore')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {anomalies.map((a) => (
                      <tr key={a.date} className="border-b border-gray-700 last:border-0">
                        <td className="px-4 py-2 text-sm text-gray-300">{a.date}</td>
                        <td className="px-4 py-2">
                          <span
                            className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                              a.direction === 'spike'
                                ? 'bg-red-900/40 text-red-300'
                                : 'bg-blue-900/40 text-blue-300'
                            }`}
                          >
                            {t(`aiCenter.direction.${a.direction}`, { defaultValue: a.direction })}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-sm text-white">
                          ${a.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-4 py-2 text-sm font-mono text-gray-400">{a.z_score}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </div>
      )}

      {tab === 'notes' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 max-w-5xl">
          <div className="space-y-4">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-white mb-3">{t('aiCenter.addKnowledgeNote')}</h3>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!noteTitle.trim() || !noteBody.trim()) {
                    setNoteError(t('aiCenter.titleBodyRequired'))
                    return
                  }
                  createNoteMutation.mutate({ title: noteTitle.trim(), body: noteBody.trim() })
                }}
                className="space-y-3"
              >
                <input
                  value={noteTitle}
                  onChange={(e) => setNoteTitle(e.target.value)}
                  placeholder={t('aiCenter.titlePlaceholder')}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <textarea
                  value={noteBody}
                  onChange={(e) => setNoteBody(e.target.value)}
                  rows={4}
                  placeholder={t('aiCenter.bodyPlaceholder')}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                {noteError && (
                  <div className="p-2 rounded-lg bg-red-900/40 border border-red-700 text-red-400 text-xs">
                    {noteError}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={createNoteMutation.isPending}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                >
                  {t('aiCenter.saveNote')}
                </button>
              </form>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-white mb-3">{t('aiCenter.semanticSearch')}</h3>
              <form onSubmit={searchNotes} className="flex gap-2">
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('aiCenter.searchPlaceholder')}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  type="submit"
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  {t('common.search')}
                </button>
              </form>
              {searchResults && (
                <div className="mt-3 space-y-2">
                  <p className="text-xs text-gray-500">
                    {t(searchMode === 'semantic' ? 'aiCenter.semanticMode' : 'aiCenter.keywordMode')} —{' '}
                    {t('aiCenter.resultsCount', { count: searchResults.length })}
                  </p>
                  {searchResults.map((r) => (
                    <div key={r.id} className="bg-gray-800 rounded-lg p-3">
                      <p className="text-sm text-white font-medium">{r.title}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{r.body}</p>
                      {r.score < 1 && (
                        <p className="text-xs text-indigo-400 mt-1">{t('aiCenter.score')} {r.score}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden self-start">
            <div className="px-5 py-4 border-b border-gray-800">
              <h3 className="text-sm font-semibold text-white">{t('aiCenter.notesCount', { count: notes.length })}</h3>
            </div>
            {notesLoading ? (
              <div className="p-5 text-gray-500 text-sm">{t('common.loading')}</div>
            ) : notes.length === 0 ? (
              <div className="p-5 text-center text-gray-500 text-sm">{t('aiCenter.noNotes')}</div>
            ) : (
              <div className="divide-y divide-gray-800">
                {notes.map((n) => (
                  <div key={n.id} className="px-5 py-3">
                    <p className="text-sm text-white font-medium">{n.title}</p>
                    <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{n.body}</p>
                    <p className="text-xs text-gray-600 mt-1">
                      {new Date(n.created_at).toLocaleDateString()}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'settings' && (
        <div className="max-w-2xl space-y-3">
          {settingsLoading ? (
            <div className="text-gray-500 text-sm">{t('common.loading')}</div>
          ) : (
            settings &&
            (
              [
                ['assistant_enabled', 'aiCenter.settingAssistant'],
                ['smart_recs_enabled', 'aiCenter.settingSmartRecs'],
                ['forecast_enabled', 'aiCenter.settingForecast'],
                ['anomaly_enabled', 'aiCenter.settingAnomaly'],
                ['rag_enabled', 'aiCenter.settingRag'],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center justify-between">
                <span className="text-sm text-white">{t(label)}</span>
                <button
                  onClick={() =>
                    settingsMutation.mutate({ [key]: !settings[key as keyof AiSettings] })
                  }
                  className={`${toggleCls} ${settings[key as keyof AiSettings] ? 'bg-green-600' : 'bg-gray-700'}`}
                  title={settings[key as keyof AiSettings] ? t('aiCenter.enabled') : t('aiCenter.disabled')}
                >
                  <span
                    className={`${knobCls} ${
                      settings[key as keyof AiSettings] ? 'translate-x-[18px]' : 'translate-x-[3px]'
                    }`}
                  />
                </button>
              </div>
            ))
          )}
          <p className="text-xs text-gray-600">
            {t('aiCenter.settingsNote')}
          </p>
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {t('aiCenter.providerSummary', {
              mode: t(`settings.aiProvider.mode.${providerInfo?.source ?? 'local'}`),
            })}
          </p>
        </div>
      )}
    </div>
  )
}
