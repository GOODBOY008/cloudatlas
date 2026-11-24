import { Table } from '@cloudflare/kumo/components/table'
import { Input, InputArea } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { NativeDialog } from '../components/shared/NativeDialog'
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
      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-subtle text-secondary">
        {t('ciTypes.badgeBuiltin')}
      </span>
    )
  }
  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-success/10 text-success">
      {t('ciTypes.badgeCustom')}
    </span>
  )
}

function TypeBadge({ type }: { type: string }) {
  const cls =
    type === 'enum'
      ? 'bg-violet/10 text-violet'
      : type === 'json' || type === 'list'
        ? 'bg-info/10 text-info'
        : type === 'boolean' || type === 'datetime'
          ? 'bg-warning/10 text-warning'
          : 'bg-subtle text-secondary'
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

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('ciTypes.title')}</h1>
        <Button
          variant="primary"
          onClick={openCreateType}
        >
          {t('ciTypes.newType')}
        </Button>
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
          {t('ciTypes.loadFailed')}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
        {/* Type list */}
        <div className="bg-surface border border-edge rounded-xl overflow-hidden self-start max-h-[70vh] overflow-y-auto">
          {isLoading ? (
            <div className="p-5 text-muted text-sm">{t('common.loading')}</div>
          ) : (
            <ul>
              {types.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => setSelectedId(t.id)}
                    className={`w-full text-left px-4 py-3 flex items-center gap-3 border-b border-edge last:border-0 transition-colors ${
                      selectedId === t.id ? 'bg-accent/20' : 'hover:bg-subtle/50'
                    }`}
                  >
                    <span className="text-lg">{t.icon ?? '📦'}</span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-primary truncate">{t.display_name}</span>
                      <span className="block text-xs text-muted font-mono">{t.name}</span>
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
            <div className="bg-surface border border-edge rounded-xl px-5 py-10 text-center text-muted text-sm">
              {t('ciTypes.selectHint')}
            </div>
          ) : (
            <>
              <div className="bg-surface border border-edge rounded-xl p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">{selected.icon ?? '📦'}</span>
                    <div>
                      <h3 className="text-lg font-semibold text-primary">{selected.display_name}</h3>
                      <p className="text-xs text-muted font-mono">{selected.name}</p>
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
                        className="text-danger hover:text-danger text-xs"
                      >
                        {t('ciTypes.deleteType')}
                      </button>
                    )}
                  </div>
                </div>
                <dl className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-4 text-sm">
                  <div>
                    <dt className="text-xs text-muted">{t('ciTypes.classification')}</dt>
                    <dd className="text-secondary">
                      {classifications.find((c) => c.id === selected.classification_id)
                        ?.display_name ?? '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">{t('ciTypes.cloudProvider')}</dt>
                    <dd className="text-secondary">{providerLabel(selected.cloud_provider)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">{t('ciTypes.sortOrder')}</dt>
                    <dd className="text-secondary">{selected.sort_order}</dd>
                  </div>
                  <div className="col-span-2 md:col-span-3">
                    <dt className="text-xs text-muted">{t('common.description')}</dt>
                    <dd className="text-secondary">{selected.is_builtin && selected.name === 'cloud_bucket' && selected.description === 'S3/OSS bucket' ? t('objectStorage.bucketDescription') : selected.description ?? '—'}</dd>
                  </div>
                </dl>
                {!selected.is_builtin && (
                  <div className="mt-4 flex items-center gap-3">
                    <Input
                      aria-label={t('ciTypes.renamePlaceholder')}
                      value={typeForm.display_name}
                      onChange={(e) => setTypeForm({ ...typeForm, display_name: e.target.value })}
                      className="w-full max-w-[220px]"
                      placeholder={t('ciTypes.renamePlaceholder')}
                    />
                    <Button
                      size="sm"
                      onClick={() =>
                        typeForm.display_name.trim() &&
                        updateTypeMutation.mutate({
                          id: selected.id,
                          payload: { display_name: typeForm.display_name.trim() },
                        })
                      }
                    >
                      {t('ciTypes.rename')}
                    </Button>
                  </div>
                )}
              </div>

              <div className="bg-surface border border-edge rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-edge">
                  <h4 className="text-sm font-semibold text-primary">{t('ciTypes.attributes')}</h4>
                  {!selected.is_builtin && (
                    <Button
                      variant="primary"
                      onClick={() => {
                        setAttrForm(DEFAULT_ATTR_FORM)
                        setAttrFormError('')
                        setShowAttrModal(true)
                      }}
                    >
                      {t('ciTypes.addAttribute')}
                    </Button>
                  )}
                </div>
                {attrsLoading ? (
                  <div className="p-5 text-muted text-sm">{t('common.loading')}</div>
                ) : attributes.length === 0 ? (
                  <div className="p-5 text-center text-muted text-sm">
                    {t('ciTypes.noAttributes')}
                  </div>
                ) : (
                  <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table className="text-left">
                    <Table.Header variant="compact" className="border-b border-edge">
                      <Table.Row>
                        <Table.Head className="px-4 py-3 font-medium">{t('common.name')}</Table.Head>
                        <Table.Head className="px-4 py-3 font-medium">{t('common.type')}</Table.Head>
                        <Table.Head className="px-4 py-3 font-medium">{t('ciTypes.required')}</Table.Head>
                        <Table.Head className="px-4 py-3 font-medium">{t('ciTypes.unique')}</Table.Head>
                        <Table.Head className="px-4 py-3 font-medium">{t('ciTypes.colDefault')}</Table.Head>
                        <Table.Head className="px-4 py-3 font-medium">{t('ciTypes.colEnumValues')}</Table.Head>
                        <Table.Head className="px-4 py-3 font-medium">{t('common.actions')}</Table.Head>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {attributes.map((a) => (
                        <Table.Row key={a.id} className="border-b border-strong last:border-0 hover:bg-subtle/40 transition-colors">
                          <Table.Cell className="px-4 py-3">
                            <span className="text-sm text-primary">{a.display_name}</span>
                            <span className="block text-xs text-muted font-mono">{a.name}</span>
                          </Table.Cell>
                          <Table.Cell className="px-4 py-3">
                            <TypeBadge type={a.attribute_type} />
                          </Table.Cell>
                          <Table.Cell className="px-4 py-3 text-sm text-secondary">
                            {a.is_required ? '✓' : '—'}
                          </Table.Cell>
                          <Table.Cell className="px-4 py-3 text-sm text-secondary">
                            {a.is_unique ? '✓' : '—'}
                          </Table.Cell>
                          <Table.Cell className="px-4 py-3 text-xs text-secondary font-mono">
                            {a.default_value ?? '—'}
                          </Table.Cell>
                          <Table.Cell className="px-4 py-3 text-xs text-secondary">
                            {Array.isArray(a.enum_values) ? a.enum_values.join(', ') : '—'}
                          </Table.Cell>
                          <Table.Cell className="px-4 py-3">
                            {!a.is_builtin && (
                              <Button
                                size="sm" variant="secondary-destructive"
                                onClick={() => {
                                  if (confirm(t('ciTypes.deleteAttrConfirm', { name: a.display_name }))) {
                                    deleteAttrMutation.mutate(a.id)
                                  }
                                }}
                              >
                                {t('common.delete')}
                              </Button>
                            )}
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table></div>
                )}
              </div>

              {/* Unique constraints (T2) */}
              <div className="bg-surface border border-edge rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-edge">
                  <h4 className="text-sm font-semibold text-primary">{t('ciTypes.uniqueConstraints')}</h4>
                  <Button
                    variant="primary"
                    onClick={() => {
                      setConstraintName('')
                      setConstraintAttrs(new Set())
                      setConstraintError('')
                      setShowConstraintModal(true)
                    }}
                  >
                    {t('ciTypes.addConstraint')}
                  </Button>
                </div>
                {constraints.length === 0 ? (
                  <div className="p-5 text-center text-muted text-sm">
                    {t('ciTypes.noConstraints')}
                  </div>
                ) : (
                  <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table className="text-left">
                    <Table.Header variant="compact" className="border-b border-edge">
                      <Table.Row>
                        <Table.Head className="px-4 py-3 font-medium">{t('common.name')}</Table.Head>
                        <Table.Head className="px-4 py-3 font-medium">{t('ciTypes.constraintAttrs')}</Table.Head>
                        <Table.Head className="px-4 py-3 font-medium">{t('common.actions')}</Table.Head>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {constraints.map((c) => (
                        <Table.Row key={c.id} className="border-b border-strong last:border-0 hover:bg-subtle/40 transition-colors">
                          <Table.Cell className="px-4 py-3 text-sm text-primary">{c.name}</Table.Cell>
                          <Table.Cell className="px-4 py-3">
                            <div className="flex flex-wrap gap-1">
                              {c.attr_names.map((a) => (
                                <span key={a} className="px-1.5 py-0.5 bg-emphasis text-secondary text-xs rounded font-mono">
                                  {a}
                                </span>
                              ))}
                            </div>
                          </Table.Cell>
                          <Table.Cell className="px-4 py-3">
                            <Button
                              size="sm" variant="secondary-destructive"
                              onClick={() => {
                                if (confirm(t('ciTypes.deleteConstraintConfirm', { name: c.name }))) {
                                  deleteConstraintMutation.mutate(c.id)
                                }
                              }}
                            >
                              {t('common.delete')}
                            </Button>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table></div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* New CI type modal */}
      {showTypeModal && (
        <NativeDialog className="items-center justify-center p-4" label={t('ciTypes.newTypeTitle')} onClose={() => setShowTypeModal(false)}>
          <div
            className="dialog-panel p-6 w-full max-w-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-primary mb-4">{t('ciTypes.newTypeTitle')}</h3>
            <form onSubmit={handleTypeSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Input
                    label={t('ciTypes.nameSnake')}
                    value={typeForm.name}
                    onChange={(e) => setTypeForm({ ...typeForm, name: e.target.value })}
                    className="w-full"
                    placeholder="custom_device"
                  />
                </div>
                <div>
                  <Input
                    label={t('ciTypes.displayName')}
                    value={typeForm.display_name}
                    onChange={(e) => setTypeForm({ ...typeForm, display_name: e.target.value })}
                    className="w-full"
                    placeholder="Custom Device"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <SelectField
                    label={t('ciTypes.classification')}
                    value={typeForm.classification_id}
                    onValueChange={value => setTypeForm({ ...typeForm, classification_id: value })}
                    className="w-full"
                    items={[
                      { value: "", label: t('ciTypes.none') },
                      ...classifications.map((c) => ({ value: c.id, label: c.display_name })),
                    ]}
                  />
                </div>
                <div>
                  <SelectField
                    label={t('ciTypes.cloudProvider')}
                    value={typeForm.cloud_provider}
                    onValueChange={value => setTypeForm({ ...typeForm, cloud_provider: value })}
                    className="w-full"
                    items={PROVIDERS.map((p) => ({ value: p, label: p === '' ? t('ciTypes.none') : providerLabel(p) }))}
                  />
                </div>
              </div>
              <div>
                <InputArea
                  label={t('common.description')}
                  value={typeForm.description}
                  onChange={(e) => setTypeForm({ ...typeForm, description: e.target.value })}
                  rows={2}
                  className="w-full resize-y"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-secondary mb-1">{t('ciTypes.icon')}</label>
                  <div className="flex flex-wrap gap-1">
                    {ICONS.map((icon) => (
                      <button
                        key={icon}
                        type="button"
                        onClick={() => setTypeForm({ ...typeForm, icon })}
                        className={`w-8 h-8 rounded-lg text-base transition-colors ${
                          typeForm.icon === icon
                            ? 'bg-accent'
                            : 'bg-subtle hover:bg-emphasis'
                        }`}
                      >
                        {icon}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <Input
                    label={t('ciTypes.sortOrder')}
                    type="number"
                    value={typeForm.sort_order}
                    onChange={e => setTypeForm({ ...typeForm, sort_order: Number(e.target.value) })}
                    className="w-full"
                  />
                </div>
              </div>
              {typeFormError && (
                <div className="p-3 rounded-lg bg-danger/10 border border-danger/25 text-danger text-sm">
                  {typeFormError}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => setShowTypeModal(false)}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={createTypeMutation.isPending}
                >
                  {t('ciTypes.createType')}
                </Button>
              </div>
            </form>
          </div>
        </NativeDialog>
      )}

      {/* New attribute modal */}
      {showAttrModal && selected && (
        <NativeDialog className="items-center justify-center p-4" label={t('ciTypes.addAttrTo', { name: selected.display_name })} onClose={() => setShowAttrModal(false)}>
          <div
            className="dialog-panel p-6 w-full max-w-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-primary mb-4">
              {t('ciTypes.addAttrTo', { name: selected.display_name })}
            </h3>
            <form onSubmit={handleAttrSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Input
                    label={t('ciTypes.nameSnake')}
                    value={attrForm.name}
                    onChange={(e) => setAttrForm({ ...attrForm, name: e.target.value })}
                    className="w-full"
                    placeholder="serial_number"
                  />
                </div>
                <div>
                  <Input
                    label={t('ciTypes.displayName')}
                    value={attrForm.display_name}
                    onChange={(e) => setAttrForm({ ...attrForm, display_name: e.target.value })}
                    className="w-full"
                    placeholder="Serial Number"
                  />
                </div>
              </div>
              <div>
                <SelectField
                  label={t('ciTypes.attributeType')}
                  value={attrForm.attribute_type}
                  onValueChange={value => setAttrForm({ ...attrForm, attribute_type: value })}
                  className="w-full"
                  items={ATTRIBUTE_TYPES.map((t) => ({ value: t, label: t }))}
                />
              </div>
              {attrForm.attribute_type === 'enum' && (
                <div>
                  <Input
                    label={t('ciTypes.enumValues')}
                    value={attrForm.enum_values}
                    onChange={(e) => setAttrForm({ ...attrForm, enum_values: e.target.value })}
                    className="w-full"
                    placeholder="small, medium, large"
                  />
                </div>
              )}
              <div>
                <Input
                  label={t('ciTypes.defaultValue')}
                  value={attrForm.default_value}
                  onChange={(e) => setAttrForm({ ...attrForm, default_value: e.target.value })}
                  className="w-full"
                  placeholder={t('ciTypes.optional')}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex items-center gap-2 text-sm text-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={attrForm.is_required}
                    onChange={(e) => setAttrForm({ ...attrForm, is_required: e.target.checked })}
                    className="rounded border-strong bg-subtle text-accent focus:ring-accent"
                  />
                  {t('ciTypes.required')}
                </label>
                <label className="flex items-center gap-2 text-sm text-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={attrForm.is_unique}
                    onChange={(e) => setAttrForm({ ...attrForm, is_unique: e.target.checked })}
                    className="rounded border-strong bg-subtle text-accent focus:ring-accent"
                  />
                  {t('ciTypes.unique')}
                </label>
              </div>
              {attrFormError && (
                <div className="p-3 rounded-lg bg-danger/10 border border-danger/25 text-danger text-sm">
                  {attrFormError}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => setShowAttrModal(false)}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={createAttrMutation.isPending}
                >
                  {t('ciTypes.addAttributeSubmit')}
                </Button>
              </div>
            </form>
          </div>
        </NativeDialog>
      )}
      {/* New unique constraint modal (T2) */}
      {showConstraintModal && selected && (
        <NativeDialog className="items-center justify-center p-4" label={t('ciTypes.addConstraintTo', { name: selected.display_name })} onClose={() => setShowConstraintModal(false)}>
          <div
            className="dialog-panel p-6 w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-primary mb-4">
              {t('ciTypes.addConstraintTo', { name: selected.display_name })}
            </h3>
            <form onSubmit={handleConstraintSubmit} className="space-y-4">
              <div>
                <Input
                  label={t('common.name')}
                  value={constraintName}
                  onChange={(e) => setConstraintName(e.target.value)}
                  className="w-full"
                  placeholder="unique-hostname"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-2">
                  {t('ciTypes.constraintAttrs')} ({constraintAttrs.size})
                </label>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {attributes.map((a) => (
                    <label key={a.id} className="flex items-center gap-2 text-sm text-secondary cursor-pointer">
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
                        className="rounded border-strong bg-subtle text-accent focus:ring-accent"
                      />
                      <span className="font-mono text-xs">{a.name}</span>
                      <span className="text-muted text-xs">({a.display_name})</span>
                    </label>
                  ))}
                </div>
              </div>
              {constraintError && (
                <div className="p-3 rounded-lg bg-danger/10 border border-danger/25 text-danger text-sm">
                  {constraintError}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => setShowConstraintModal(false)}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={createConstraintMutation.isPending}
                >
                  {t('ciTypes.createConstraint')}
                </Button>
              </div>
            </form>
          </div>
        </NativeDialog>
      )}
    </div>
  )
}
