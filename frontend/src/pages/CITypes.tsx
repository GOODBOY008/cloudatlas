import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { CLOUD_PROVIDERS, providerLabel } from '../lib/providers'
import type { CiAttribute, CiClassification, CiType } from '../types'

const ATTRIBUTE_TYPES = [
  'string',
  'integer',
  'float',
  'boolean',
  'datetime',
  'enum',
  'list',
  'json',
  'url',
  'ip_address',
  'cidr',
]

const PROVIDERS = ['', ...CLOUD_PROVIDERS]

interface TypeForm {
  name: string
  display_name: string
  classification_id: string
  cloud_provider: string
  description: string
  icon: string
  sort_order: number
}

/** Payload sent to the API — optional fields omitted when blank. */
type CreateTypePayload = {
  name: string
  display_name: string
  classification_id?: string
  cloud_provider?: string
  description?: string
  icon?: string
  sort_order: number
}

const DEFAULT_TYPE_FORM: TypeForm = {
  name: '',
  display_name: '',
  classification_id: '',
  cloud_provider: '',
  description: '',
  icon: '📦',
  sort_order: 100,
}

interface AttrForm {
  name: string
  display_name: string
  attribute_type: string
  is_required: boolean
  is_unique: boolean
  default_value: string
  enum_values: string
  sort_order: number
}

/** Payload sent to the API — optional fields omitted when blank. */
type CreateAttrPayload = {
  name: string
  display_name: string
  attribute_type: string
  is_required?: boolean
  is_unique?: boolean
  default_value?: string
  enum_values?: string[]
  sort_order?: number
}

const DEFAULT_ATTR_FORM: AttrForm = {
  name: '',
  display_name: '',
  attribute_type: 'string',
  is_required: false,
  is_unique: false,
  default_value: '',
  enum_values: '',
  sort_order: 100,
}

const ICONS = ['📦', '🖥', '🌐', '🗄', '🔧', '🛡', '📡', '🧩', '⚙', '🏗', '☁', '🔌']

function BuiltinBadge({ isBuiltin }: { isBuiltin: boolean }) {
  const { t } = useTranslation()
  if (isBuiltin) {
    return (
      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-800 text-gray-400">
        {t('ciTypes.badgeBuiltin')}
      </span>
    )
  }
  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-900/40 text-green-300">
      {t('ciTypes.badgeCustom')}
    </span>
  )
}

function TypeBadge({ type }: { type: string }) {
  const cls =
    type === 'enum'
      ? 'bg-purple-900/40 text-purple-300'
      : type === 'json' || type === 'list'
        ? 'bg-blue-900/40 text-blue-300'
        : type === 'boolean' || type === 'datetime'
          ? 'bg-yellow-900/40 text-yellow-300'
          : 'bg-gray-800 text-gray-300'
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{type}</span>
}

export default function CITypes() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showTypeModal, setShowTypeModal] = useState(false)
  const [typeForm, setTypeForm] = useState<TypeForm>(DEFAULT_TYPE_FORM)
  const [typeFormError, setTypeFormError] = useState('')
  const [showAttrModal, setShowAttrModal] = useState(false)
  const [attrForm, setAttrForm] = useState<AttrForm>(DEFAULT_ATTR_FORM)
  const [attrFormError, setAttrFormError] = useState('')

  const { data: types = [], isLoading, isError } = useQuery<CiType[]>({
    queryKey: ['ci-types', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CiType[] }>(`/orgs/${orgId}/ci-types`)
      return res.data ?? []
    },
  })

  const { data: classifications = [] } = useQuery<CiClassification[]>({
    queryKey: ['ci-classifications', orgId],
    enabled: !!orgId && showTypeModal,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CiClassification[] }>(
        `/orgs/${orgId}/ci-classifications`
      )
      return res.data ?? []
    },
  })

  const selected = types.find((t) => t.id === selectedId) ?? null

  const { data: attributes = [], isLoading: attrsLoading } = useQuery<CiAttribute[]>({
    queryKey: ['ci-attributes', orgId, selectedId],
    enabled: !!orgId && !!selectedId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CiAttribute[] }>(
        `/orgs/${orgId}/ci-types/${selectedId}/attributes`
      )
      return res.data ?? []
    },
  })

  const createTypeMutation = useMutation({
    mutationFn: (payload: CreateTypePayload) => api.post(`/orgs/${orgId}/ci-types`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ci-types', orgId] })
      setShowTypeModal(false)
      setTypeForm(DEFAULT_TYPE_FORM)
      setTypeFormError('')
    },
    onError: () => setTypeFormError(t('ciTypes.createTypeFailed')),
  })

  const updateTypeMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<TypeForm> }) =>
      api.put(`/orgs/${orgId}/ci-types/${id}`, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ci-types', orgId] }),
    onError: () => setTypeFormError(t('ciTypes.updateTypeFailed')),
  })

  const deleteTypeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/ci-types/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ci-types', orgId] })
      if (selectedId) setSelectedId(null)
    },
  })

  const createAttrMutation = useMutation({
    mutationFn: (payload: CreateAttrPayload) =>
      api.post(`/orgs/${orgId}/ci-types/${selectedId}/attributes`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ci-attributes', orgId, selectedId] })
      setShowAttrModal(false)
      setAttrForm(DEFAULT_ATTR_FORM)
      setAttrFormError('')
    },
    onError: () => setAttrFormError(t('ciTypes.addAttrFailed')),
  })

  const deleteAttrMutation = useMutation({
    mutationFn: (attrId: string) =>
      api.delete(`/orgs/${orgId}/ci-types/${selectedId}/attributes/${attrId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ci-attributes', orgId, selectedId] }),
  })

  // ── Unique constraints (T2) ──
  const [showConstraintModal, setShowConstraintModal] = useState(false)
  const [constraintName, setConstraintName] = useState('')
  const [constraintAttrs, setConstraintAttrs] = useState<Set<string>>(new Set())
  const [constraintError, setConstraintError] = useState('')

  const { data: constraints = [] } = useQuery<Array<{ id: string; name: string; attr_names: string[] }>>({
    queryKey: ['ci-unique-constraints', orgId, selectedId],
    enabled: !!orgId && !!selectedId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: Array<{ id: string; name: string; attr_names: string[] }> }>(
        `/orgs/${orgId}/ci-types/${selectedId}/unique-constraints`
      )
      return res.data ?? []
    },
  })

  const createConstraintMutation = useMutation({
    mutationFn: (payload: { name: string; attr_names: string[] }) =>
      api.post(`/orgs/${orgId}/ci-types/${selectedId}/unique-constraints`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ci-unique-constraints', orgId, selectedId] })
      setShowConstraintModal(false)
      setConstraintName('')
      setConstraintAttrs(new Set())
      setConstraintError('')
    },
    onError: (err: any) => {
      setConstraintError(err?.response?.data?.error?.message ?? t('ciTypes.constraintCreateFailed'))
    },
  })

  const deleteConstraintMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/unique-constraints/${id}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['ci-unique-constraints', orgId, selectedId] }),
  })

  function handleConstraintSubmit(e: FormEvent) {
    e.preventDefault()
    setConstraintError('')
    if (!constraintName.trim() || constraintAttrs.size === 0) {
      setConstraintError(t('ciTypes.constraintFormInvalid'))
      return
    }
    createConstraintMutation.mutate({
      name: constraintName.trim(),
      attr_names: Array.from(constraintAttrs),
    })
  }

  function openCreateType() {
    setTypeForm(DEFAULT_TYPE_FORM)
    setTypeFormError('')
    setShowTypeModal(true)
  }

  function handleTypeSubmit(e: FormEvent) {
    e.preventDefault()
    setTypeFormError('')
    if (!typeForm.name.trim() || !typeForm.display_name.trim()) {
      setTypeFormError(t('ciTypes.nameRequired'))
      return
    }
    const payload: CreateTypePayload = {
      name: typeForm.name.trim(),
      display_name: typeForm.display_name.trim(),
      sort_order: typeForm.sort_order,
      ...(typeForm.classification_id ? { classification_id: typeForm.classification_id } : {}),
      ...(typeForm.cloud_provider ? { cloud_provider: typeForm.cloud_provider } : {}),
      ...(typeForm.description.trim() ? { description: typeForm.description.trim() } : {}),
      ...(typeForm.icon ? { icon: typeForm.icon } : {}),
    }
    createTypeMutation.mutate(payload)
  }

  function handleAttrSubmit(e: FormEvent) {
    e.preventDefault()
    setAttrFormError('')
    if (!attrForm.name.trim() || !attrForm.display_name.trim()) {
      setAttrFormError(t('ciTypes.nameRequired'))
      return
    }
    const enumValues =
      attrForm.attribute_type === 'enum' && attrForm.enum_values.trim()
        ? attrForm.enum_values.split(',').map((v) => v.trim()).filter(Boolean)
        : undefined
    const payload: CreateAttrPayload = {
      name: attrForm.name.trim(),
      display_name: attrForm.display_name.trim(),
      attribute_type: attrForm.attribute_type,
      ...(attrForm.is_required ? { is_required: true } : {}),
      ...(attrForm.is_unique ? { is_unique: true } : {}),
      ...(attrForm.default_value.trim() ? { default_value: attrForm.default_value.trim() } : {}),
      ...(enumValues ? { enum_values: enumValues } : {}),
    }
    createAttrMutation.mutate(payload)
  }

  const inputCls =
    'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-500'

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">{t('ciTypes.title')}</h2>
        <button
          onClick={openCreateType}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {t('ciTypes.newType')}
        </button>
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
          {t('ciTypes.loadFailed')}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
        {/* Type list */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden self-start max-h-[70vh] overflow-y-auto">
          {isLoading ? (
            <div className="p-5 text-gray-500 text-sm">{t('common.loading')}</div>
          ) : (
            <ul>
              {types.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => setSelectedId(t.id)}
                    className={`w-full text-left px-4 py-3 flex items-center gap-3 border-b border-gray-800 last:border-0 transition-colors ${
                      selectedId === t.id ? 'bg-indigo-600/20' : 'hover:bg-gray-800/50'
                    }`}
                  >
                    <span className="text-lg">{t.icon ?? '📦'}</span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-white truncate">{t.display_name}</span>
                      <span className="block text-xs text-gray-500 font-mono">{t.name}</span>
                    </span>
                    <BuiltinBadge isBuiltin={t.is_builtin} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Detail pane */}
        <div className="space-y-4">
          {!selected ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-10 text-center text-gray-500 text-sm">
              {t('ciTypes.selectHint')}
            </div>
          ) : (
            <>
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">{selected.icon ?? '📦'}</span>
                    <div>
                      <h3 className="text-lg font-semibold text-white">{selected.display_name}</h3>
                      <p className="text-xs text-gray-500 font-mono">{selected.name}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <BuiltinBadge isBuiltin={selected.is_builtin} />
                    {!selected.is_builtin && (
                      <button
                        onClick={() => {
                          if (confirm(t('ciTypes.deleteTypeConfirm', { name: selected.display_name }))) {
                            deleteTypeMutation.mutate(selected.id)
                          }
                        }}
                        className="text-red-400 hover:text-red-300 text-xs"
                      >
                        {t('ciTypes.deleteType')}
                      </button>
                    )}
                  </div>
                </div>
                <dl className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-4 text-sm">
                  <div>
                    <dt className="text-xs text-gray-500">{t('ciTypes.classification')}</dt>
                    <dd className="text-gray-300">
                      {classifications.find((c) => c.id === selected.classification_id)
                        ?.display_name ?? '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-gray-500">{t('ciTypes.cloudProvider')}</dt>
                    <dd className="text-gray-300">{providerLabel(selected.cloud_provider)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-gray-500">{t('ciTypes.sortOrder')}</dt>
                    <dd className="text-gray-300">{selected.sort_order}</dd>
                  </div>
                  <div className="col-span-2 md:col-span-3">
                    <dt className="text-xs text-gray-500">{t('common.description')}</dt>
                    <dd className="text-gray-300">{selected.description ?? '—'}</dd>
                  </div>
                </dl>
                {!selected.is_builtin && (
                  <div className="mt-4 flex items-center gap-3">
                    <input
                      value={typeForm.display_name}
                      onChange={(e) => setTypeForm({ ...typeForm, display_name: e.target.value })}
                      className={`${inputCls} max-w-[220px]`}
                      placeholder={t('ciTypes.renamePlaceholder')}
                    />
                    <button
                      onClick={() =>
                        typeForm.display_name.trim() &&
                        updateTypeMutation.mutate({
                          id: selected.id,
                          payload: { display_name: typeForm.display_name.trim() },
                        })
                      }
                      className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-white text-xs font-medium rounded-lg transition-colors"
                    >
                      {t('ciTypes.rename')}
                    </button>
                  </div>
                )}
              </div>

              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
                  <h4 className="text-sm font-semibold text-white">{t('ciTypes.attributes')}</h4>
                  {!selected.is_builtin && (
                    <button
                      onClick={() => {
                        setAttrForm(DEFAULT_ATTR_FORM)
                        setAttrFormError('')
                        setShowAttrModal(true)
                      }}
                      className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg transition-colors"
                    >
                      {t('ciTypes.addAttribute')}
                    </button>
                  )}
                </div>
                {attrsLoading ? (
                  <div className="p-5 text-gray-500 text-sm">{t('common.loading')}</div>
                ) : attributes.length === 0 ? (
                  <div className="p-5 text-center text-gray-500 text-sm">
                    {t('ciTypes.noAttributes')}
                  </div>
                ) : (
                  <table className="w-full text-left">
                    <thead className="border-b border-gray-800 text-xs uppercase text-gray-500">
                      <tr>
                        <th className="px-4 py-3 font-medium">{t('common.name')}</th>
                        <th className="px-4 py-3 font-medium">{t('common.type')}</th>
                        <th className="px-4 py-3 font-medium">{t('ciTypes.required')}</th>
                        <th className="px-4 py-3 font-medium">{t('ciTypes.unique')}</th>
                        <th className="px-4 py-3 font-medium">{t('ciTypes.colDefault')}</th>
                        <th className="px-4 py-3 font-medium">{t('ciTypes.colEnumValues')}</th>
                        <th className="px-4 py-3 font-medium">{t('common.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {attributes.map((a) => (
                        <tr key={a.id} className="border-b border-gray-700 last:border-0 hover:bg-gray-800/40 transition-colors">
                          <td className="px-4 py-3">
                            <span className="text-sm text-white">{a.display_name}</span>
                            <span className="block text-xs text-gray-500 font-mono">{a.name}</span>
                          </td>
                          <td className="px-4 py-3">
                            <TypeBadge type={a.attribute_type} />
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-300">
                            {a.is_required ? '✓' : '—'}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-300">
                            {a.is_unique ? '✓' : '—'}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-400 font-mono">
                            {a.default_value ?? '—'}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-400">
                            {Array.isArray(a.enum_values) ? a.enum_values.join(', ') : '—'}
                          </td>
                          <td className="px-4 py-3">
                            {!a.is_builtin && (
                              <button
                                onClick={() => {
                                  if (confirm(t('ciTypes.deleteAttrConfirm', { name: a.display_name }))) {
                                    deleteAttrMutation.mutate(a.id)
                                  }
                                }}
                                className="text-red-400 hover:text-red-300 text-xs"
                              >
                                {t('common.delete')}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Unique constraints (T2) */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
                  <h4 className="text-sm font-semibold text-white">{t('ciTypes.uniqueConstraints')}</h4>
                  <button
                    onClick={() => {
                      setConstraintName('')
                      setConstraintAttrs(new Set())
                      setConstraintError('')
                      setShowConstraintModal(true)
                    }}
                    className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg transition-colors"
                  >
                    {t('ciTypes.addConstraint')}
                  </button>
                </div>
                {constraints.length === 0 ? (
                  <div className="p-5 text-center text-gray-500 text-sm">
                    {t('ciTypes.noConstraints')}
                  </div>
                ) : (
                  <table className="w-full text-left">
                    <thead className="border-b border-gray-800 text-xs uppercase text-gray-500">
                      <tr>
                        <th className="px-4 py-3 font-medium">{t('common.name')}</th>
                        <th className="px-4 py-3 font-medium">{t('ciTypes.constraintAttrs')}</th>
                        <th className="px-4 py-3 font-medium">{t('common.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {constraints.map((c) => (
                        <tr key={c.id} className="border-b border-gray-700 last:border-0 hover:bg-gray-800/40 transition-colors">
                          <td className="px-4 py-3 text-sm text-white">{c.name}</td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1">
                              {c.attr_names.map((a) => (
                                <span key={a} className="px-1.5 py-0.5 bg-gray-700 text-gray-300 text-xs rounded font-mono">
                                  {a}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <button
                              onClick={() => {
                                if (confirm(t('ciTypes.deleteConstraintConfirm', { name: c.name }))) {
                                  deleteConstraintMutation.mutate(c.id)
                                }
                              }}
                              className="text-red-400 hover:text-red-300 text-xs"
                            >
                              {t('common.delete')}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* New CI type modal */}
      {showTypeModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowTypeModal(false)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-lg shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-4">{t('ciTypes.newTypeTitle')}</h3>
            <form onSubmit={handleTypeSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">{t('ciTypes.nameSnake')}</label>
                  <input
                    value={typeForm.name}
                    onChange={(e) => setTypeForm({ ...typeForm, name: e.target.value })}
                    className={inputCls}
                    placeholder="custom_device"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">{t('ciTypes.displayName')}</label>
                  <input
                    value={typeForm.display_name}
                    onChange={(e) => setTypeForm({ ...typeForm, display_name: e.target.value })}
                    className={inputCls}
                    placeholder="Custom Device"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">{t('ciTypes.classification')}</label>
                  <select
                    value={typeForm.classification_id}
                    onChange={(e) => setTypeForm({ ...typeForm, classification_id: e.target.value })}
                    className={inputCls}
                  >
                    <option value="">{t('ciTypes.none')}</option>
                    {classifications.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.display_name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">{t('ciTypes.cloudProvider')}</label>
                  <select
                    value={typeForm.cloud_provider}
                    onChange={(e) => setTypeForm({ ...typeForm, cloud_provider: e.target.value })}
                    className={inputCls}
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {p === '' ? t('ciTypes.none') : providerLabel(p)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">{t('common.description')}</label>
                <textarea
                  value={typeForm.description}
                  onChange={(e) => setTypeForm({ ...typeForm, description: e.target.value })}
                  rows={2}
                  className={inputCls}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">{t('ciTypes.icon')}</label>
                  <div className="flex flex-wrap gap-1">
                    {ICONS.map((icon) => (
                      <button
                        key={icon}
                        type="button"
                        onClick={() => setTypeForm({ ...typeForm, icon })}
                        className={`w-8 h-8 rounded-lg text-base transition-colors ${
                          typeForm.icon === icon
                            ? 'bg-indigo-600'
                            : 'bg-gray-800 hover:bg-gray-700'
                        }`}
                      >
                        {icon}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">{t('ciTypes.sortOrder')}</label>
                  <input
                    type="number"
                    value={typeForm.sort_order}
                    onChange={(e) => setTypeForm({ ...typeForm, sort_order: Number(e.target.value) })}
                    className={inputCls}
                  />
                </div>
              </div>
              {typeFormError && (
                <div className="p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-400 text-sm">
                  {typeFormError}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowTypeModal(false)}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createTypeMutation.isPending}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                >
                  {t('ciTypes.createType')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* New attribute modal */}
      {showAttrModal && selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowAttrModal(false)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-lg shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-4">
              {t('ciTypes.addAttrTo', { name: selected.display_name })}
            </h3>
            <form onSubmit={handleAttrSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">{t('ciTypes.nameSnake')}</label>
                  <input
                    value={attrForm.name}
                    onChange={(e) => setAttrForm({ ...attrForm, name: e.target.value })}
                    className={inputCls}
                    placeholder="serial_number"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">{t('ciTypes.displayName')}</label>
                  <input
                    value={attrForm.display_name}
                    onChange={(e) => setAttrForm({ ...attrForm, display_name: e.target.value })}
                    className={inputCls}
                    placeholder="Serial Number"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">{t('ciTypes.attributeType')}</label>
                <select
                  value={attrForm.attribute_type}
                  onChange={(e) => setAttrForm({ ...attrForm, attribute_type: e.target.value })}
                  className={inputCls}
                >
                  {ATTRIBUTE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              {attrForm.attribute_type === 'enum' && (
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">
                    {t('ciTypes.enumValues')}
                  </label>
                  <input
                    value={attrForm.enum_values}
                    onChange={(e) => setAttrForm({ ...attrForm, enum_values: e.target.value })}
                    className={inputCls}
                    placeholder="small, medium, large"
                  />
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">{t('ciTypes.defaultValue')}</label>
                <input
                  value={attrForm.default_value}
                  onChange={(e) => setAttrForm({ ...attrForm, default_value: e.target.value })}
                  className={inputCls}
                  placeholder={t('ciTypes.optional')}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={attrForm.is_required}
                    onChange={(e) => setAttrForm({ ...attrForm, is_required: e.target.checked })}
                    className="rounded border-gray-600 bg-gray-800 text-indigo-500 focus:ring-indigo-500"
                  />
                  {t('ciTypes.required')}
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={attrForm.is_unique}
                    onChange={(e) => setAttrForm({ ...attrForm, is_unique: e.target.checked })}
                    className="rounded border-gray-600 bg-gray-800 text-indigo-500 focus:ring-indigo-500"
                  />
                  {t('ciTypes.unique')}
                </label>
              </div>
              {attrFormError && (
                <div className="p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-400 text-sm">
                  {attrFormError}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAttrModal(false)}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createAttrMutation.isPending}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                >
                  {t('ciTypes.addAttributeSubmit')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* New unique constraint modal (T2) */}
      {showConstraintModal && selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowConstraintModal(false)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-4">
              {t('ciTypes.addConstraintTo', { name: selected.display_name })}
            </h3>
            <form onSubmit={handleConstraintSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">{t('common.name')}</label>
                <input
                  value={constraintName}
                  onChange={(e) => setConstraintName(e.target.value)}
                  className={inputCls}
                  placeholder="unique-hostname"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-2">
                  {t('ciTypes.constraintAttrs')} ({constraintAttrs.size})
                </label>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {attributes.map((a) => (
                    <label key={a.id} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={constraintAttrs.has(a.name)}
                        onChange={() =>
                          setConstraintAttrs((prev) => {
                            const next = new Set(prev)
                            if (next.has(a.name)) next.delete(a.name)
                            else next.add(a.name)
                            return next
                          })
                        }
                        className="rounded border-gray-600 bg-gray-800 text-indigo-500 focus:ring-indigo-500"
                      />
                      <span className="font-mono text-xs">{a.name}</span>
                      <span className="text-gray-500 text-xs">({a.display_name})</span>
                    </label>
                  ))}
                </div>
              </div>
              {constraintError && (
                <div className="p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-400 text-sm">
                  {constraintError}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowConstraintModal(false)}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createConstraintMutation.isPending}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                >
                  {t('ciTypes.createConstraint')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
