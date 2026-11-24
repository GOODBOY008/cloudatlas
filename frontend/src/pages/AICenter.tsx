import { PageTabs } from '../components/shared/PageTabs'
import { Table } from '@cloudflare/kumo/components/table'
import { Input, InputArea } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
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
  const knobCls = 'inline-block h-3.5 w-3.5 transform rounded-full bg-surface transition-transform'

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('aiCenter.title')}</h1>
      </div>

      <PageTabs
        value={tab}
        onValueChange={setTab}
        className="mb-4"
        tabs={(['assistant', 'forecast', 'anomalies', 'notes', 'settings'] as const).map(tabKey => ({ value: tabKey, label: tabLabels[tabKey] }))}
      />

      {tab === 'assistant' && (
        <div className="max-w-xl">
          <div className="bg-surface border border-edge rounded-xl p-8 text-center">
            <Sparkles size={28} className="mx-auto text-accent mb-3" />
            <h3 className="text-lg font-semibold text-primary mb-1">
              {t('copilot.redirectTitle')}
            </h3>
            <p className="text-sm text-secondary mb-5">{t('copilot.redirectBody')}</p>
            <Button
              variant="primary"
              onClick={(event) => {
                event.currentTarget.focus()
                useCopilotStore.getState().setOpen(true)
              }}
            >
              <Sparkles size={15} />
              {t('copilot.openCopilot')}
            </Button>
          </div>
        </div>
      )}

      {tab === 'forecast' && (
        <div className="max-w-3xl space-y-4">
          <div className="bg-surface border border-edge rounded-xl p-5">
            <p className="text-sm text-secondary mb-3">
              {t('aiCenter.forecastDesc')}
            </p>
            <Button
              variant="primary"
              onClick={runForecast}
            >
              {t('aiCenter.generateForecast')}
            </Button>
            {forecast?.summary && (
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div className="bg-subtle rounded-lg p-3">
                  <p className="text-xs text-muted">{t('aiCenter.historicalTotal90d')}</p>
                  <p className="text-primary font-semibold">
                    ${Number(forecast.summary.historical_total).toLocaleString()}
                  </p>
                </div>
                <div className="bg-subtle rounded-lg p-3">
                  <p className="text-xs text-muted">{t('aiCenter.projectedNext14d')}</p>
                  <p className="text-primary font-semibold">
                    ${Number(forecast.summary.projected_total_next_14d).toLocaleString()}
                  </p>
                </div>
              </div>
            )}
          </div>
          {forecast && (
            <div className="bg-surface border border-edge rounded-xl overflow-hidden">
              <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table className="text-left">
                <Table.Header variant="compact" className="border-b border-edge">
                  <Table.Row>
                    <Table.Head className="px-4 py-2 font-medium">{t('aiCenter.colDate')}</Table.Head>
                    <Table.Head className="px-4 py-2 font-medium">{t('aiCenter.colForecast')}</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {forecast.points.map((p) => (
                    <Table.Row key={p.date} className="border-b border-strong last:border-0">
                      <Table.Cell className="px-4 py-2 text-sm text-secondary">{p.date}</Table.Cell>
                      <Table.Cell className="px-4 py-2 text-sm text-primary">
                        ${p.forecast.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table></div>
            </div>
          )}
        </div>
      )}

      {tab === 'anomalies' && (
        <div className="max-w-3xl space-y-4">
          <div className="bg-surface border border-edge rounded-xl p-5">
            <p className="text-sm text-secondary mb-3">
              {t('aiCenter.anomaliesDesc')}
            </p>
            <Button
              variant="primary"
              onClick={runAnomalies}
            >
              {t('aiCenter.scanForAnomalies')}
            </Button>
          </div>
          {anomalies && (
            anomalies.length === 0 ? (
              <div className="bg-surface border border-edge rounded-xl px-5 py-8 text-center text-muted text-sm">
                {t('aiCenter.noAnomaliesDetected')}
              </div>
            ) : (
              <div className="bg-surface border border-edge rounded-xl overflow-hidden">
                <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table className="text-left">
                  <Table.Header variant="compact" className="border-b border-edge">
                    <Table.Row>
                      <Table.Head className="px-4 py-2 font-medium">{t('aiCenter.colDate')}</Table.Head>
                      <Table.Head className="px-4 py-2 font-medium">{t('aiCenter.colDirection')}</Table.Head>
                      <Table.Head className="px-4 py-2 font-medium">{t('aiCenter.colValue')}</Table.Head>
                      <Table.Head className="px-4 py-2 font-medium">{t('aiCenter.colZScore')}</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {anomalies.map((a) => (
                      <Table.Row key={a.date} className="border-b border-strong last:border-0">
                        <Table.Cell className="px-4 py-2 text-sm text-secondary">{a.date}</Table.Cell>
                        <Table.Cell className="px-4 py-2">
                          <span
                            className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                              a.direction === 'spike'
                                ? 'bg-danger/10 text-danger'
                                : 'bg-info/10 text-info'
                            }`}
                          >
                            {t(`aiCenter.direction.${a.direction}`, { defaultValue: a.direction })}
                          </span>
                        </Table.Cell>
                        <Table.Cell className="px-4 py-2 text-sm text-primary">
                          ${a.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </Table.Cell>
                        <Table.Cell className="px-4 py-2 text-sm font-mono text-secondary">{a.z_score}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table></div>
              </div>
            )
          )}
        </div>
      )}

      {tab === 'notes' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 max-w-5xl">
          <div className="space-y-4">
            <div className="bg-surface border border-edge rounded-xl p-5">
              <h3 className="text-sm font-semibold text-primary mb-3">{t('aiCenter.addKnowledgeNote')}</h3>
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
                <Input
                  aria-label={t('aiCenter.titlePlaceholder')}
                  value={noteTitle}
                  onChange={(e) => setNoteTitle(e.target.value)}
                  placeholder={t('aiCenter.titlePlaceholder')}
                  className="w-full"
                />
                <InputArea
                  aria-label={t('aiCenter.bodyPlaceholder')}
                  value={noteBody}
                  onChange={(e) => setNoteBody(e.target.value)}
                  rows={4}
                  placeholder={t('aiCenter.bodyPlaceholder')}
                  className="w-full resize-y"
                />
                {noteError && (
                  <div className="p-2 rounded-lg bg-danger/10 border border-danger/25 text-danger text-xs">
                    {noteError}
                  </div>
                )}
                <Button
                  variant="primary"
                  type="submit"
                  disabled={createNoteMutation.isPending}
                >
                  {t('aiCenter.saveNote')}
                </Button>
              </form>
            </div>
            <div className="bg-surface border border-edge rounded-xl p-5">
              <h3 className="text-sm font-semibold text-primary mb-3">{t('aiCenter.semanticSearch')}</h3>
              <form onSubmit={searchNotes} className="flex gap-2">
                <Input
                  aria-label={t('aiCenter.searchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('aiCenter.searchPlaceholder')}
                  className="flex-1"
                />
                <Button
                  variant="primary"
                  type="submit"
                >
                  {t('common.search')}
                </Button>
              </form>
              {searchResults && (
                <div className="mt-3 space-y-2">
                  <p className="text-xs text-muted">
                    {t(searchMode === 'semantic' ? 'aiCenter.semanticMode' : 'aiCenter.keywordMode')} —{' '}
                    {t('aiCenter.resultsCount', { count: searchResults.length })}
                  </p>
                  {searchResults.map((r) => (
                    <div key={r.id} className="bg-subtle rounded-lg p-3">
                      <p className="text-sm text-primary font-medium">{r.title}</p>
                      <p className="text-xs text-secondary mt-0.5">{r.body}</p>
                      {r.score < 1 && (
                        <p className="text-xs text-accent mt-1">{t('aiCenter.score')} {r.score}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="bg-surface border border-edge rounded-xl overflow-hidden self-start">
            <div className="px-5 py-4 border-b border-edge">
              <h3 className="text-sm font-semibold text-primary">{t('aiCenter.notesCount', { count: notes.length })}</h3>
            </div>
            {notesLoading ? (
              <div className="p-5 text-muted text-sm">{t('common.loading')}</div>
            ) : notes.length === 0 ? (
              <div className="p-5 text-center text-muted text-sm">{t('aiCenter.noNotes')}</div>
            ) : (
              <div className="divide-y divide-edge">
                {notes.map((n) => (
                  <div key={n.id} className="px-5 py-3">
                    <p className="text-sm text-primary font-medium">{n.title}</p>
                    <p className="text-xs text-secondary mt-0.5 line-clamp-2">{n.body}</p>
                    <p className="text-xs text-muted mt-1">
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
            <div className="text-muted text-sm">{t('common.loading')}</div>
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
              <div key={key} className="bg-surface border border-edge rounded-xl p-4 flex items-center justify-between">
                <span className="text-sm text-primary">{t(label)}</span>
                <button
                  onClick={() =>
                    settingsMutation.mutate({ [key]: !settings[key as keyof AiSettings] })
                  }
                  className={`${toggleCls} ${settings[key as keyof AiSettings] ? 'bg-success-solid' : 'bg-emphasis'}`}
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
          <p className="text-xs text-muted">
            {t('aiCenter.settingsNote')}
          </p>
          <p className="text-xs text-secondary">
            {t('aiCenter.providerSummary', {
              mode: t(`settings.aiProvider.mode.${providerInfo?.source ?? 'local'}`),
            })}
          </p>
        </div>
      )}
    </div>
  )
}
