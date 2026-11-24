import { Table } from '@cloudflare/kumo/components/table'
import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'

interface ServiceTemplate {
  id: string
  organization_id: string | null
  name: string
  display_name: string
  description?: string
  service_type?: string
  tags?: string[]
  is_active: boolean
  item_count: number
  created_at: string
}

interface TemplateItem {
  id: string
  template_id: string
  ci_type_id: string
  ci_type_name: string
  ci_type_display: string
  role?: string
  is_required: boolean
  min_count: number
  max_count?: number | null
}

interface CIType {
  id: string
  name: string
  display_name: string
}

const SERVICE_TYPES = ['web_application', 'database', 'message_queue', 'api_gateway', 'storage', 'compute', 'other']

export default function ServiceTemplates() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const [selectedTemplate, setSelectedTemplate] = useState<ServiceTemplate | null>(null)
  const [showTemplateForm, setShowTemplateForm] = useState(false)
  const [editTemplateId, setEditTemplateId] = useState<string | null>(null)

  // Template form state
  const [tName, setTName] = useState('')
  const [tDisplay, setTDisplay] = useState('')
  const [tDesc, setTDesc] = useState('')
  const [tType, setTType] = useState('')
  const [tTags, setTTags] = useState('')
  const [tActive, setTActive] = useState(true)
  const [tError, setTError] = useState('')

  // Item form state
  const [showItemForm, setShowItemForm] = useState(false)
  const [iCITypeId, setICITypeId] = useState('')
  const [iRole, setIRole] = useState('')
  const [iRequired, setIRequired] = useState(true)
  const [iMin, setIMin] = useState(1)
  const [iMax, setIMax] = useState<string>('')
  const [iError, setIError] = useState('')

  const { data: templates = [], isLoading } = useQuery<ServiceTemplate[]>({
    queryKey: ['service-templates', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: ServiceTemplate[] }>(
        `/orgs/${orgId}/service-templates`
      )
      return res.data ?? []
    },
  })

  const { data: templateDetail } = useQuery<{ template: ServiceTemplate; items: TemplateItem[] }>({
    queryKey: ['service-template-detail', orgId, selectedTemplate?.id],
    enabled: !!orgId && !!selectedTemplate,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: { template: ServiceTemplate; items: TemplateItem[] } }>(
        `/orgs/${orgId}/service-templates/${selectedTemplate!.id}`
      )
      return res.data
    },
  })

  const { data: ciTypes = [] } = useQuery<CIType[]>({
    queryKey: ['ci-types-list', orgId],
    enabled: !!orgId && showItemForm,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CIType[] }>(`/orgs/${orgId}/ci-types`)
      return res.data ?? []
    },
  })

  function resetTemplateForm() {
    setTName(''); setTDisplay(''); setTDesc(''); setTType(''); setTTags('')
    setTActive(true); setEditTemplateId(null); setTError(''); setShowTemplateForm(false)
  }

  const createTemplate = useMutation({
    mutationFn: () =>
      api.post(`/orgs/${orgId}/service-templates`, {
        name: tName.trim(),
        display_name: tDisplay.trim(),
        description: tDesc.trim() || undefined,
        service_type: tType || undefined,
        tags: tTags ? tTags.split(',').map(t => t.trim()).filter(Boolean) : undefined,
        is_active: tActive,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-templates', orgId] })
      resetTemplateForm()
    },
    onError: () => setTError(t('serviceTemplates.createFailed')),
  })

  const updateTemplate = useMutation({
    mutationFn: () =>
      api.put(`/orgs/${orgId}/service-templates/${editTemplateId}`, {
        display_name: tDisplay.trim(),
        description: tDesc.trim() || undefined,
        service_type: tType || undefined,
        tags: tTags ? tTags.split(',').map(t => t.trim()).filter(Boolean) : undefined,
        is_active: tActive,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-templates', orgId] })
      if (selectedTemplate?.id === editTemplateId) {
        queryClient.invalidateQueries({ queryKey: ['service-template-detail', orgId, editTemplateId] })
      }
      resetTemplateForm()
    },
    onError: () => setTError(t('serviceTemplates.updateFailed')),
  })

  const deleteTemplate = useMutation({
    mutationFn: (id: string) =>
      api.delete(`/orgs/${orgId}/service-templates/${id}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['service-templates', orgId] })
      if (selectedTemplate?.id === id) setSelectedTemplate(null)
    },
  })

  const addItem = useMutation({
    mutationFn: () =>
      api.post(`/orgs/${orgId}/service-templates/${selectedTemplate!.id}/items`, {
        ci_type_id: iCITypeId,
        role: iRole.trim() || undefined,
        is_required: iRequired,
        min_count: iMin,
        max_count: iMax ? Number(iMax) : undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-template-detail', orgId, selectedTemplate?.id] })
      queryClient.invalidateQueries({ queryKey: ['service-templates', orgId] })
      setShowItemForm(false)
      setICITypeId(''); setIRole(''); setIRequired(true); setIMin(1); setIMax(''); setIError('')
    },
    onError: () => setIError(t('serviceTemplates.addItemFailed')),
  })

  const removeItem = useMutation({
    mutationFn: (itemId: string) =>
      api.delete(`/orgs/${orgId}/service-templates/${selectedTemplate!.id}/items/${itemId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-template-detail', orgId, selectedTemplate?.id] })
      queryClient.invalidateQueries({ queryKey: ['service-templates', orgId] })
    },
  })

  const tBusy = createTemplate.isPending || updateTemplate.isPending

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('serviceTemplates.title')}</h1>
          <p className="text-sm text-secondary mt-0.5">
            {t('serviceTemplates.subtitle')}
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => { resetTemplateForm(); setShowTemplateForm(true) }}
        >
          {t('serviceTemplates.newTemplate')}
        </Button>
      </div>

      {/* Template Form */}
      {showTemplateForm && (
        <div className="bg-subtle rounded-xl border border-strong p-5 space-y-4">
          <h2 className="text-base font-semibold text-primary">
            {editTemplateId ? t('serviceTemplates.editTitle') : t('serviceTemplates.newTitle')}
          </h2>
          {tError && <p className="text-danger text-sm">{tError}</p>}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Input
                label={t('serviceTemplates.nameKeyLabel')}
                value={tName}
                onChange={e => setTName(e.target.value)}
                disabled={!!editTemplateId}
                placeholder={t('serviceTemplates.nameKeyPlaceholder')}
                className="w-full"
              />
            </div>
            <div>
              <Input
                label={t('serviceTemplates.displayName')}
                value={tDisplay}
                onChange={e => setTDisplay(e.target.value)}
                placeholder={t('serviceTemplates.displayNamePlaceholder')}
                className="w-full"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <SelectField
                label={t('serviceTemplates.serviceType')}
                value={tType}
                onValueChange={setTType}
                className="w-full"
                items={[
                  { value: "", label: t('serviceTemplates.none') },
                  ...SERVICE_TYPES.map(st => ({ value: st, label: t(`serviceTemplates.types.${st}`) })),
                ]}
              />
            </div>
            <div>
              <Input
                label={t('serviceTemplates.tagsLabel')}
                value={tTags}
                onChange={e => setTTags(e.target.value)}
                placeholder={t('serviceTemplates.tagsPlaceholder')}
                className="w-full"
              />
            </div>
          </div>
          <div>
            <Input
              label={t('common.description')}
              value={tDesc}
              onChange={e => setTDesc(e.target.value)}
              className="w-full"
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={tActive} onChange={e => setTActive(e.target.checked)} className="w-4 h-4" />
            <span className="text-sm text-secondary">{t('common.active')}</span>
          </label>
          <div className="flex gap-3">
            <Button
              variant="primary"
              disabled={tBusy || !tName.trim() || !tDisplay.trim()}
              onClick={() => editTemplateId ? updateTemplate.mutate() : createTemplate.mutate()}
            >
              {tBusy ? t('serviceTemplates.saving') : editTemplateId ? t('serviceTemplates.update') : t('serviceTemplates.create')}
            </Button>
            <Button onClick={resetTemplateForm}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Template List */}
        <div className="w-full shrink-0 space-y-2 lg:w-64">
          {isLoading ? (
            <p className="text-muted text-sm">{t('common.loading')}</p>
          ) : templates.length === 0 ? (
            <div className="text-center py-10 text-muted text-sm">{t('serviceTemplates.noTemplates')}</div>
          ) : (
            templates.map(tmpl => (
              <div
                key={tmpl.id}
                onClick={() => setSelectedTemplate(tmpl)}
                className={`p-3 rounded-xl border cursor-pointer transition-colors ${
                  selectedTemplate?.id === tmpl.id
                    ? 'bg-accent-soft/30 border-accent'
                    : 'bg-surface border-edge hover:border-strong'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-medium text-primary">{tmpl.display_name}</p>
                    <p className="text-xs text-muted mt-0.5 font-mono">{tmpl.name}</p>
                  </div>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${tmpl.is_active ? 'bg-success/10 text-success' : 'bg-emphasis text-muted'}`}>
                    {tmpl.is_active ? t('serviceTemplates.statusActive') : t('serviceTemplates.statusInactive')}
                  </span>
                </div>
                {tmpl.service_type && (
                  <p className="text-xs text-muted mt-1">{t(`serviceTemplates.types.${tmpl.service_type}`, { defaultValue: tmpl.service_type.replace(/_/g, ' ') })}</p>
                )}
                <div className="flex items-center justify-between mt-2">
                  <span className="text-xs text-accent">{t('serviceTemplates.ciTypesCount', { count: tmpl.item_count })}</span>
                  <div className="flex gap-2">
                    <button
                      onClick={e => {
                        e.stopPropagation()
                        setEditTemplateId(tmpl.id)
                        setTName(tmpl.name); setTDisplay(tmpl.display_name)
                        setTDesc(tmpl.description ?? ''); setTType(tmpl.service_type ?? '')
                        setTTags((tmpl.tags ?? []).join(', ')); setTActive(tmpl.is_active)
                        setShowTemplateForm(true)
                      }}
                      className="text-xs text-info hover:text-info"
                    >{t('common.edit')}</button>
                    <button
                      onClick={e => {
                        e.stopPropagation()
                        if (confirm(t('serviceTemplates.confirmDeleteTemplate', { name: tmpl.display_name }))) deleteTemplate.mutate(tmpl.id)
                      }}
                      className="text-xs text-danger hover:text-danger"
                    >{t('common.delete')}</button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Detail Panel */}
        {selectedTemplate ? (
          <div className="flex-1 bg-surface rounded-xl border border-edge p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-primary">{selectedTemplate.display_name}</h2>
              <Button
                variant="primary"
                onClick={() => setShowItemForm(true)}
              >
                {t('serviceTemplates.addCiType')}
              </Button>
            </div>
            {selectedTemplate.description && (
              <p className="text-sm text-secondary">{selectedTemplate.description}</p>
            )}
            {selectedTemplate.tags && selectedTemplate.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {selectedTemplate.tags.map(tag => (
                  <span key={tag} className="text-xs px-2 py-0.5 bg-subtle text-secondary rounded-full">{tag}</span>
                ))}
              </div>
            )}

            {/* Add Item Form */}
            {showItemForm && (
              <div className="bg-subtle rounded-xl border border-strong p-4 space-y-3">
                <h3 className="text-sm font-semibold text-primary">{t('serviceTemplates.addCiTypeTitle')}</h3>
                {iError && <p className="text-danger text-xs">{iError}</p>}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <SelectField
                      label={t('serviceTemplates.ciType')}
                      value={iCITypeId}
                      onValueChange={setICITypeId}
                      className="w-full"
                      items={[
                        { value: "", label: t('serviceTemplates.select') },
                        ...ciTypes.map(ct => ({ value: ct.id, label: ct.display_name })),
                      ]}
                    />
                  </div>
                  <div>
                    <Input
                      label={t('serviceTemplates.role')}
                      value={iRole}
                      onChange={e => setIRole(e.target.value)}
                      placeholder={t('serviceTemplates.rolePlaceholder')}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <Input
                      label={t('serviceTemplates.minCount')}
                      type="number"
                      value={iMin}
                      min={0}
                      onChange={e => setIMin(Number(e.target.value))}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <Input
                      label={t('serviceTemplates.maxCountLabel')}
                      type="number"
                      value={iMax}
                      min={1}
                      onChange={e => setIMax(e.target.value)}
                      placeholder={t('serviceTemplates.unlimited')}
                      className="w-full"
                    />
                  </div>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={iRequired} onChange={e => setIRequired(e.target.checked)} className="w-4 h-4" />
                  <span className="text-sm text-secondary">{t('serviceTemplates.required')}</span>
                </label>
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    disabled={addItem.isPending || !iCITypeId}
                    onClick={() => addItem.mutate()}
                  >
                    {addItem.isPending ? t('serviceTemplates.adding') : t('serviceTemplates.add')}
                  </Button>
                  <Button
                    onClick={() => { setShowItemForm(false); setIError('') }}
                  >{t('common.cancel')}</Button>
                </div>
              </div>
            )}

            {/* Items Table */}
            {templateDetail?.items && templateDetail.items.length > 0 ? (
              <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
                <Table.Header variant="compact">
                  <Table.Row className="text-xs text-muted border-b border-edge">
                    <Table.Head className="text-left py-2">{t('serviceTemplates.ciType')}</Table.Head>
                    <Table.Head className="text-left py-2">{t('serviceTemplates.role')}</Table.Head>
                    <Table.Head className="text-center py-2">{t('serviceTemplates.required')}</Table.Head>
                    <Table.Head className="text-center py-2">{t('serviceTemplates.count')}</Table.Head>
                    <Table.Head className="text-right py-2"></Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {templateDetail.items.map(item => (
                    <Table.Row key={item.id} className="border-b border-edge/40">
                      <Table.Cell className="py-2 text-primary">{item.ci_type_display}</Table.Cell>
                      <Table.Cell className="py-2 text-secondary text-xs">{item.role ?? '—'}</Table.Cell>
                      <Table.Cell className="py-2 text-center">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${item.is_required ? 'bg-danger/10 text-danger' : 'bg-emphasis text-secondary'}`}>
                          {item.is_required ? t('serviceTemplates.requiredBadge') : t('serviceTemplates.optionalBadge')}
                        </span>
                      </Table.Cell>
                      <Table.Cell className="py-2 text-center text-secondary text-xs">
                        {item.min_count}–{item.max_count ?? '∞'}
                      </Table.Cell>
                      <Table.Cell className="py-2 text-right">
                        <Button
                          size="sm" variant="secondary-destructive"
                          onClick={() => { if (confirm(t('serviceTemplates.confirmRemoveItem'))) removeItem.mutate(item.id) }}
                        >{t('serviceTemplates.remove')}</Button>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table></div>
            ) : (
              <div className="text-center py-10 text-muted text-sm">
                {t('serviceTemplates.noItems')}
              </div>
            )}
          </div>
        ) : (
          <div className="empty-state panel min-w-0 flex-1">
            {t('serviceTemplates.selectTemplate')}
          </div>
        )}
      </div>
    </div>
  )
}
