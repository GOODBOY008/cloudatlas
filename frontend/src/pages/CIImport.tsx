import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'

interface CIType {
  id: string
  name: string
  display_name: string
}

interface RowResult {
  row: number
  name?: string
  status: string
  ci_id?: string
  error?: string
  reason?: string
  errors?: { attribute: string; message: string }[]
}

interface ServerImportResult {
  total_rows: number
  created: number
  updated: number
  skipped: number
  failed: number
  conflict_strategy: string
  results: RowResult[]
}

export default function CIImport() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const [selectedTypeId, setSelectedTypeId] = useState('')
  const [conflictStrategy, setConflictStrategy] = useState<'skip' | 'upsert'>('skip')
  const [result, setResult] = useState<ServerImportResult | null>(null)
  const [uploadError, setUploadError] = useState('')
  const [selectedFileName, setSelectedFileName] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const { data: ciTypes = [] } = useQuery<CIType[]>({
    queryKey: ['ci-types-list', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CIType[] }>(`/orgs/${orgId}/ci-types`)
      return res.data ?? []
    },
  })

  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData()
      form.append('file', file)
      form.append('ci_type_id', selectedTypeId)
      form.append('conflict_strategy', conflictStrategy)
      const { data: res } = await api.post<{ data: ServerImportResult }>(
        `/orgs/${orgId}/cis/import`,
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      )
      return res.data
    },
    onSuccess: (data) => {
      setResult(data)
      setUploadError('')
      queryClient.invalidateQueries({ queryKey: ['cmdb', orgId] })
      queryClient.invalidateQueries({ queryKey: ['cis', orgId] })
    },
    onError: (err: any) => {
      setUploadError(
        err?.response?.data?.error?.message ?? t('ciImport.importFailed')
      )
    },
  })

  function handleFileUpload(file: File) {
    setSelectedFileName(file.name)
    setResult(null)
    setUploadError('')
    importMutation.mutate(file)
  }

  async function downloadTemplate() {
    const res = await api.get(
      `/orgs/${orgId}/ci-types/${selectedTypeId}/import-template`,
      { responseType: 'blob' }
    )
    const url = URL.createObjectURL(res.data as Blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'ci_import_template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const selectedType = ciTypes.find((t) => t.id === selectedTypeId)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-white">{t('ciImport.title')}</h1>
        <p className="text-sm text-gray-400 mt-0.5">{t('ciImport.subtitleServer')}</p>
      </div>

      {/* Type + strategy + template */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white">{t('ciImport.setup')}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">{t('ciImport.defaultType')} *</label>
            <select
              value={selectedTypeId}
              onChange={(e) => setSelectedTypeId(e.target.value)}
              data-testid="ciimport-type-select"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="">{t('ciImport.selectType')}</option>
              {ciTypes.map((t) => (
                <option key={t.id} value={t.id}>{t.display_name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">{t('ciImport.conflictStrategy')}</label>
            <select
              value={conflictStrategy}
              onChange={(e) => setConflictStrategy(e.target.value as 'skip' | 'upsert')}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="skip">{t('ciImport.strategySkip')}</option>
              <option value="upsert">{t('ciImport.strategyUpsert')}</option>
            </select>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={downloadTemplate}
            disabled={!selectedTypeId}
            data-testid="ciimport-download-template"
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-xs rounded-lg transition-colors"
          >
            {t('ciImport.downloadTemplate')}
          </button>
          <p className="text-xs text-gray-500">
            {selectedType
              ? t('ciImport.templateHint', { name: selectedType.display_name })
              : t('ciImport.templateHintNoType')}
          </p>
        </div>
      </div>

      {/* Upload */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">{t('ciImport.csvData')}</h2>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={!selectedTypeId || importMutation.isPending}
            data-testid="ciimport-upload-button"
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {importMutation.isPending ? t('ciImport.importing') : t('ciImport.uploadAndImport')}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) handleFileUpload(f)
            }}
          />
        </div>
        <p className="text-xs text-gray-500">
          {t('ciImport.serverImportHint')}
          {selectedFileName && (
            <span className="ml-2 text-gray-300 font-mono" data-testid="ciimport-filename">{selectedFileName}</span>
          )}
        </p>
        {uploadError && (
          <p className="text-red-400 text-xs" data-testid="ciimport-error">{uploadError}</p>
        )}
      </div>

      {/* Result */}
      {result && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3" data-testid="ciimport-result">
          <h2 className="text-sm font-semibold text-white">{t('ciImport.resultTitle')}</h2>
          <div className="flex gap-6 flex-wrap">
            {([
              ['created', 'text-green-400'],
              ['updated', 'text-blue-400'],
              ['skipped', 'text-yellow-400'],
              ['failed', 'text-red-400'],
            ] as const).map(([key, cls]) => (
              <div key={key} className="text-center">
                <p className={`text-3xl font-bold ${cls}`}>{result[key]}</p>
                <p className="text-xs text-gray-500 mt-1">{t(`ciImport.${key}`)}</p>
              </div>
            ))}
          </div>
          {result.results.some((r) => r.status === 'error' || r.status === 'skipped') && (
            <div className="bg-red-950/30 border border-red-900/40 rounded-lg p-3 space-y-1 max-h-64 overflow-y-auto">
              <p className="text-xs font-medium text-red-300">{t('ciImport.rowIssues')}</p>
              {result.results
                .filter((r) => r.status === 'error' || r.status === 'skipped')
                .map((r) => (
                  <p key={`${r.row}-${r.name ?? ''}`} className="text-xs text-red-400">
                    {t('ciImport.rowError', { n: r.row, message: r.error ?? r.reason ?? '' })}
                    {r.errors?.map((e) => ` [${e.attribute}] ${e.message}`).join('; ')}
                  </p>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
