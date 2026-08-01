import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'

interface FieldTemplate {
  id: string
  name: string
  display_name?: string
  description?: string
  attributes: Array<{
    name: string
    display_name?: string
    attribute_type: string
    is_required?: boolean
    is_unique?: boolean
    default_value?: string
    enum_values?: string[]
  }>
  created_at: string
}

interface CIType {
  id: string
  name: string
  display_name: string
  is_builtin?: boolean
}

interface TemplateDiff {
  data: {
    template_id: string
    ci_type_id: string
    added: Array<{ name: string; attribute_type: string }>
    conflicts: Array<{ attribute: string; changes: string[] }>
    extra: string[]
  }
}

const ATTRIBUTE_TYPES = [
  'string', 'integer', 'float', 'boolean', 'datetime', 'enum', 'list', 'json', 'url', 'ip_address', 'cidr',
]

export default function FieldTemplates() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const [showModal, setShowModal] = useState(false)
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [attrText, setAttrText] = useState(
    JSON.stringify(
      [
        { name: 'owner_team', display_name: 'Owner Team', attribute_type: 'string', is_required: false },
        { name: 'cost_center', display_name: 'Cost Center', attribute_type: 'string', is_required: false },
      ],
      null,
      2,
    ),
  )
  const [formError, setFormError] = useState('')

  // Selected template + its bound types + diff target
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [bindTypeId, setBindTypeId] = useState('')
  const [diffTypeId, setDiffTypeId] = useState('')
  const [actionMessage, setActionMessage] = useState('')

  const { data: templates = [], isLoading } = useQuery<FieldTemplate[]>({
    queryKey: ['field-templates', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: FieldTemplate[] }>(`/orgs/${orgId}/field-templates`)
      return res.data ?? []
    },
  })

  const { data: ciTypes = [] } = useQuery<CIType[]>({
    queryKey: ['ci-types', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CIType[] }>(`/orgs/${orgId}/ci-types`)
      return res.data ?? []
    },
  })

  const selected = templates.find((ft) => ft.id === selectedId) ?? null

  const { data: boundTypes = [] } = useQuery<CIType[]>({
    queryKey: ['field-template-types', orgId, selectedId],
    enabled: !!orgId && !!selectedId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CIType[] }>(`/orgs/${orgId}/field-templates/${selectedId}/types`)
      return res.data ?? []
    },
  })

  const { data: diff, refetch: refetchDiff, isFetching: diffLoading } = useQuery<TemplateDiff['data']>({
    queryKey: ['field-template-diff', orgId, selectedId, diffTypeId],
    enabled: !!orgId && !!selectedId && !!diffTypeId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: TemplateDiff['data'] }>(
        `/orgs/${orgId}/field-templates/${selectedId}/diff/${diffTypeId}`,
      )
      return res.data
    },
  })

  const createMutation = useMutation({
    mutationFn: (payload: { name: string; display_name?: string; attributes: unknown }) =>
      api.post(`/orgs/${orgId}/field-templates`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['field-templates', orgId] })
      setShowModal(false)
      setName('')
      setDisplayName('')
      setFormError('')
    },
    onError: (err: any) => setFormError(err?.response?.data?.error?.message ?? t('fieldTemplates.createFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/field-templates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['field-templates', orgId] })
      if (selectedId) setSelectedId(null)
    },
  })

  const bindMutation = useMutation({
    mutationFn: ({ typeIds, unbind }: { typeIds: string[]; unbind?: boolean }) =>
      unbind
        ? api.delete(`/orgs/${orgId}/field-templates/${selectedId}/unbind`, { data: { ci_type_ids: typeIds } })
        : api.post(`/orgs/${orgId}/field-templates/${selectedId}/bind`, { ci_type_ids: typeIds }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['field-template-types', orgId, selectedId] })
      setBindTypeId('')
      setActionMessage('')
    },
  })

  const applyMutation = useMutation({
    mutationFn: (dryRun: boolean) =>
      api.post(`/orgs/${orgId}/field-templates/${selectedId}/apply`, {
        ci_type_ids: diffTypeId ? [diffTypeId] : [],
        dry_run: dryRun,
      }),
    onSuccess: (res: any) => {
      const d = res?.data?.data
      const lines = (d?.per_type ?? [])
        .map((pt: any) =>
          `${t('fieldTemplates.typeLabel')}: +${pt.created_attributes?.length ?? 0} / ~${pt.updated_attributes?.length ?? 0}${pt.error ? ` (${pt.error})` : ''}`,
        )
        .join(' · ')
      setActionMessage(
        `${d?.dry_run ? t('fieldTemplates.dryRunPrefix') : t('fieldTemplates.applyPrefix')} — ${lines}`,
      )
      if (!d?.dry_run) {
        queryClient.invalidateQueries({ queryKey: ['field-template-diff', orgId, selectedId, diffTypeId] })
        refetchDiff()
      }
    },
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError('')
    if (!name.trim()) {
      setFormError(t('fieldTemplates.nameRequired'))
      return
    }
    let attributes: unknown
    try {
      attributes = JSON.parse(attrText)
    } catch {
      setFormError(t('fieldTemplates.invalidJson'))
      return
    }
    if (!Array.isArray(attributes)) {
      setFormError(t('fieldTemplates.mustBeArray'))
      return
    }
    createMutation.mutate({ name: name.trim(), display_name: displayName.trim() || undefined, attributes })
  }

  const inputCls =
    'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-500'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">{t('fieldTemplates.title')}</h2>
          <p className="text-sm text-gray-400 mt-0.5">{t('fieldTemplates.subtitle')}</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {t('fieldTemplates.newTemplate')}
        </button>
      </div>

      {isLoading ? (
        <div className="text-gray-500 text-sm">{t('common.loading')}</div>
      ) : templates.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-8 text-center text-gray-500 text-sm">
          {t('fieldTemplates.empty')}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {templates.map((ft) => (
            <div
              key={ft.id}
              className={`bg-gray-900 border rounded-xl p-4 cursor-pointer transition-colors ${
                selectedId === ft.id ? 'border-indigo-500' : 'border-gray-800 hover:border-gray-700'
              }`}
              onClick={() => {
                setSelectedId(ft.id)
                setDiffTypeId('')
                setActionMessage('')
              }}
              data-testid={`field-template-${ft.name}`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-white">{ft.display_name || ft.name}</h3>
                  <p className="text-xs text-gray-500 font-mono mt-0.5">{ft.name}</p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (confirm(t('fieldTemplates.deleteConfirm', { name: ft.name }))) {
                      deleteMutation.mutate(ft.id)
                    }
                  }}
                  className="text-red-400 hover:text-red-300 text-xs"
                >
                  {t('common.delete')}
                </button>
              </div>
              <div className="flex flex-wrap gap-1 mt-3">
                {(ft.attributes ?? []).slice(0, 6).map((a) => (
                  <span key={a.name} className="px-1.5 py-0.5 bg-gray-800 text-gray-300 text-xs rounded font-mono">
                    {a.name}
                    <span className="text-gray-500 ml-1">{a.attribute_type}</span>
                  </span>
                ))}
                {ft.attributes.length > 6 && (
                  <span className="text-xs text-gray-500">+{ft.attributes.length - 6}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Binding panel */}
      {selected && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4" data-testid="field-template-binding">
          <h3 className="text-sm font-semibold text-white">
            {t('fieldTemplates.bindingFor', { name: selected.display_name || selected.name })}
          </h3>

          {/* Bound types */}
          <div>
            <p className="text-xs text-gray-500 mb-2">{t('fieldTemplates.boundTypes')}</p>
            {boundTypes.length === 0 ? (
              <p className="text-gray-600 text-sm">{t('fieldTemplates.noBoundTypes')}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {boundTypes.map((bt) => (
                  <span
                    key={bt.id}
                    className="px-2 py-1 bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-200 flex items-center gap-2"
                  >
                    {bt.display_name}
                    <button
                      onClick={() => bindMutation.mutate({ typeIds: [bt.id], unbind: true })}
                      className="text-gray-500 hover:text-red-400"
                      aria-label={t('fieldTemplates.unbindAria')}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Bind new type */}
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs text-gray-400 mb-1">{t('fieldTemplates.bindType')}</label>
              <select value={bindTypeId} onChange={(e) => setBindTypeId(e.target.value)} className={inputCls}>
                <option value="">{t('fieldTemplates.selectType')}</option>
                {ciTypes
                  .filter((ct) => !boundTypes.some((b) => b.id === ct.id))
                  .map((ct) => (
                    <option key={ct.id} value={ct.id}>{ct.display_name}</option>
                  ))}
              </select>
            </div>
            <button
              onClick={() => bindTypeId && bindMutation.mutate({ typeIds: [bindTypeId] })}
              disabled={!bindTypeId || bindMutation.isPending}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
            >
              {t('fieldTemplates.bind')}
            </button>
          </div>

          {/* Diff + apply */}
          <div className="border-t border-gray-800 pt-4 space-y-3">
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label className="block text-xs text-gray-400 mb-1">{t('fieldTemplates.diffType')}</label>
                <select
                  value={diffTypeId}
                  onChange={(e) => {
                    setDiffTypeId(e.target.value)
                    setActionMessage('')
                  }}
                  className={inputCls}
                  data-testid="field-template-diff-select"
                >
                  <option value="">{t('fieldTemplates.selectType')}</option>
                  {ciTypes.map((ct) => (
                    <option key={ct.id} value={ct.id}>{ct.display_name}</option>
                  ))}
                </select>
              </div>
              <button
                onClick={() => diffTypeId && refetchDiff()}
                disabled={!diffTypeId || diffLoading}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
                data-testid="field-template-diff-button"
              >
                {diffLoading ? t('common.loading') : t('fieldTemplates.showDiff')}
              </button>
            </div>

            {diff && (
              <div className="bg-gray-800/50 rounded-lg p-3 text-xs space-y-2" data-testid="field-template-diff-result">
                <p>
                  <span className="text-green-400">+{diff.added.length}</span>{' '}
                  <span className="text-gray-400">{t('fieldTemplates.toAdd')}</span>
                  {' · '}
                  <span className="text-yellow-400">~{diff.conflicts.length}</span>{' '}
                  <span className="text-gray-400">{t('fieldTemplates.conflicts')}</span>
                  {' · '}
                  <span className="text-gray-500">+{diff.extra.length}</span>{' '}
                  <span className="text-gray-400">{t('fieldTemplates.typeOnly')}</span>
                </p>
                {diff.added.length > 0 && (
                  <p className="text-gray-300">
                    {t('fieldTemplates.toAdd')}: {diff.added.map((a) => a.name).join(', ')}
                  </p>
                )}
                {diff.conflicts.length > 0 && (
                  <div className="text-yellow-300">
                    {diff.conflicts.map((c) => (
                      <p key={String(c.attribute)}>{String(c.attribute)}: {c.changes.join('; ')}</p>
                    ))}
                  </div>
                )}
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => applyMutation.mutate(true)}
                    disabled={applyMutation.isPending || !diffTypeId}
                    className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-xs rounded-lg"
                    data-testid="field-template-dry-run"
                  >
                    {t('fieldTemplates.dryRun')}
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(t('fieldTemplates.applyConfirm'))) applyMutation.mutate(false)
                    }}
                    disabled={applyMutation.isPending || !diffTypeId}
                    className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs rounded-lg"
                    data-testid="field-template-apply"
                  >
                    {t('fieldTemplates.apply')}
                  </button>
                </div>
              </div>
            )}

            {actionMessage && (
              <p className="text-xs text-blue-300" data-testid="field-template-action-message">{actionMessage}</p>
            )}
          </div>
        </div>
      )}

      {/* New template modal */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowModal(false)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-lg shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-4">{t('fieldTemplates.newTemplateTitle')}</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">{t('common.name')}</label>
                  <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="standard-host-fields" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">{t('ciTypes.displayName')}</label>
                  <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputCls} placeholder="Standard Host Fields" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-2">
                  {t('fieldTemplates.attributesJson')} ({ATTRIBUTE_TYPES.length} {t('fieldTemplates.typesSupported')})
                </label>
                <textarea
                  value={attrText}
                  onChange={(e) => setAttrText(e.target.value)}
                  rows={8}
                  className={`${inputCls} font-mono text-xs`}
                />
              </div>
              {formError && (
                <div className="p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-400 text-sm">{formError}</div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                >
                  {t('fieldTemplates.create')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
