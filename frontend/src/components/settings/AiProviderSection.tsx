import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, Trash2 } from 'lucide-react'
import api from '../../lib/api'
import { useOrgStore } from '../../store/orgStore'

interface ProviderInfo {
  source: 'org' | 'env' | 'local'
  api_key_set: boolean
  api_key_hint: string | null
  env_present: boolean
  stored: {
    ai_provider_enabled: boolean
    ai_base_url: string | null
    ai_chat_model: string | null
    ai_embed_model: string | null
  }
  effective: {
    base_url: string
    chat_model: string
    embed_model: string
  }
}

const MODE_BADGE: Record<string, string> = {
  org: 'bg-indigo-50 dark:bg-indigo-950/60 border-indigo-200 dark:border-indigo-900 text-indigo-600 dark:text-indigo-300',
  env: 'bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300',
  local: 'bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400',
}

/** Settings → AI Provider tab (spec 2026-08-14-ai-provider-config-ui §5.1). */
export default function AiProviderSection() {
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const [info, setInfo] = useState<ProviderInfo | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [chatModel, setChatModel] = useState('')
  const [embedModel, setEmbedModel] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string | null } | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [adminDenied, setAdminDenied] = useState(false)

  useEffect(() => {
    if (!orgId) return
    api
      .get<{ data: ProviderInfo }>(`/orgs/${orgId}/ai/provider`)
      .then((res) => {
        const d = res.data.data
        setInfo(d)
        setEnabled(d.stored.ai_provider_enabled)
        setBaseUrl(d.stored.ai_base_url ?? '')
        setChatModel(d.stored.ai_chat_model ?? '')
        setEmbedModel(d.stored.ai_embed_model ?? '')
      })
      .catch(() => {})
  }, [orgId])

  function requestBody() {
    return {
      ai_provider_enabled: enabled,
      ai_base_url: baseUrl.trim() || null,
      ai_chat_model: chatModel.trim() || null,
      ai_embed_model: embedModel.trim() || null,
      ...(clearKey ? { api_key: '__CLEAR__' } : apiKey.trim() ? { api_key: apiKey.trim() } : {}),
    }
  }

  async function runTest() {
    if (!orgId || testing) return
    setTesting(true)
    setTestResult(null)
    try {
      const { data: res } = await api.post<{ data: { ok: boolean; error?: string | null } }>(
        `/orgs/${orgId}/ai/provider/test`,
        requestBody()
      )
      setTestResult(res.data)
    } catch {
      setTestResult({ ok: false, error: 'request failed' })
    } finally {
      setTesting(false)
    }
  }

  async function save() {
    if (!orgId || saving) return
    setSaving(true)
    setMessage('')
    setError('')
    setAdminDenied(false)
    try {
      await api.put(`/orgs/${orgId}/ai/provider`, requestBody())
      setMessage(t('settings.aiProvider.saved'))
      setApiKey('')
      setClearKey(false)
      const { data: res } = await api.get<{ data: ProviderInfo }>(`/orgs/${orgId}/ai/provider`)
      setInfo(res.data)
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } })?.response?.status
      if (status === 403) {
        setAdminDenied(true)
      } else {
        setError(
          (e as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
            ?.message ?? 'save failed'
        )
      }
    } finally {
      setSaving(false)
    }
  }

  const source = info?.source ?? 'local'

  return (
    <div className="max-w-2xl space-y-4">
      {/* Mode badge */}
      <div className="flex items-center gap-3">
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium ${MODE_BADGE[source]}`}>
          <Sparkles size={12} />
          {t(`settings.aiProvider.mode.${source}`)}
        </span>
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('settings.aiProvider.desc')}</p>
      </div>

      {source === 'local' && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          {t('settings.aiProvider.localHint')}
        </div>
      )}

      {adminDenied && (
        <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {t('settings.aiProvider.adminOnly')}
        </div>
      )}

      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 space-y-4">
        {/* Enable toggle */}
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="w-4 h-4 rounded accent-indigo-600"
          />
          <span className="text-sm font-medium text-gray-900 dark:text-white">
            {t('settings.aiProvider.enable')}
          </span>
        </label>

        {/* Base URL */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            {t('settings.aiProvider.baseUrl')}
          </label>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={info?.effective.base_url ?? 'https://api.openai.com/v1'}
            className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{t('settings.aiProvider.baseUrlHelp')}</p>
        </div>

        {/* API key */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            {t('settings.aiProvider.apiKey')}
          </label>
          {info?.api_key_set && !clearKey && (
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs text-green-600 dark:text-green-400 font-mono">
                {t('settings.aiProvider.apiKeySet', { hint: info.api_key_hint ?? '' })}
              </span>
              <button
                type="button"
                onClick={() => setClearKey(true)}
                className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-red-500 transition-colors"
              >
                <Trash2 size={12} /> {t('settings.aiProvider.clearKey')}
              </button>
            </div>
          )}
          {clearKey ? (
            <p className="text-xs text-red-500">{t('settings.aiProvider.clearKey')} ✓</p>
          ) : (
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={info?.api_key_set ? t('settings.aiProvider.apiKeyKeep') : 'sk-…'}
              className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          )}
        </div>

        {/* Models */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              {t('settings.aiProvider.chatModel')}
            </label>
            <input
              value={chatModel}
              onChange={(e) => setChatModel(e.target.value)}
              placeholder={info?.effective.chat_model ?? 'gpt-4o-mini'}
              className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              {t('settings.aiProvider.embedModel')}
            </label>
            <input
              value={embedModel}
              onChange={(e) => setEmbedModel(e.target.value)}
              placeholder={info?.effective.embed_model ?? 'text-embedding-3-small'}
              className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
        </div>

        {(testResult || message || error) && (
          <div>
            {testResult &&
              (testResult.ok ? (
                <div className="rounded-lg border border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-950/40 px-3 py-2 text-sm text-green-700 dark:text-green-400">
                  {t('settings.aiProvider.testOk')}
                </div>
              ) : (
                <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                  {t('settings.aiProvider.testFail', { error: testResult.error ?? '' })}
                </div>
              ))}
            {message && !error && (
              <div className="mt-2 text-sm text-green-600 dark:text-green-400">{message}</div>
            )}
            {error && (
              <div className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</div>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {t('settings.aiProvider.save')}
          </button>
          <button
            type="button"
            onClick={runTest}
            disabled={testing}
            className="px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {testing ? t('settings.aiProvider.testing') : t('settings.aiProvider.test')}
          </button>
        </div>
      </div>
    </div>
  )
}
