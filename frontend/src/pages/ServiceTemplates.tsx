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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">{t('serviceTemplates.title')}</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {t('serviceTemplates.subtitle')}
          </p>
        </div>
        <button
          onClick={() => { resetTemplateForm(); setShowTemplateForm(true) }}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg"
        >
          {t('serviceTemplates.newTemplate')}
        </button>
      </div>

      {/* Template Form */}
      {showTemplateForm && (
        <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 space-y-4">
          <h2 className="text-base font-semibold text-white">
            {editTemplateId ? t('serviceTemplates.editTitle') : t('serviceTemplates.newTitle')}
          </h2>
          {tError && <p className="text-red-400 text-sm">{tError}</p>}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('serviceTemplates.nameKeyLabel')}</label>
              <input
                value={tName}
                onChange={e => setTName(e.target.value)}
                disabled={!!editTemplateId}
                placeholder={t('serviceTemplates.nameKeyPlaceholder')}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('serviceTemplates.displayName')}</label>
              <input
                value={tDisplay}
                onChange={e => setTDisplay(e.target.value)}
                placeholder={t('serviceTemplates.displayNamePlaceholder')}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('serviceTemplates.serviceType')}</label>
              <select
                value={tType}
                onChange={e => setTType(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
              >
                <option value="">{t('serviceTemplates.none')}</option>
                {SERVICE_TYPES.map(st => (
                  <option key={st} value={st}>{t(`serviceTemplates.types.${st}`)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('serviceTemplates.tagsLabel')}</label>
              <input
                value={tTags}
                onChange={e => setTTags(e.target.value)}
                placeholder={t('serviceTemplates.tagsPlaceholder')}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">{t('common.description')}</label>
            <input
              value={tDesc}
              onChange={e => setTDesc(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={tActive} onChange={e => setTActive(e.target.checked)} className="w-4 h-4" />
            <span className="text-sm text-gray-300">{t('common.active')}</span>
          </label>
          <div className="flex gap-3">
            <button
              disabled={tBusy || !tName.trim() || !tDisplay.trim()}
              onClick={() => editTemplateId ? updateTemplate.mutate() : createTemplate.mutate()}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg"
            >
              {tBusy ? t('serviceTemplates.saving') : editTemplateId ? t('serviceTemplates.update') : t('serviceTemplates.create')}
            </button>
            <button onClick={resetTemplateForm} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg">
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="flex gap-4">
        {/* Template List */}
        <div className="w-64 shrink-0 space-y-2">
          {isLoading ? (
            <p className="text-gray-500 text-sm">{t('common.loading')}</p>
          ) : templates.length === 0 ? (
            <div className="text-center py-10 text-gray-600 text-sm">{t('serviceTemplates.noTemplates')}</div>
          ) : (
            templates.map(tmpl => (
              <div
                key={tmpl.id}
                onClick={() => setSelectedTemplate(tmpl)}
                className={`p-3 rounded-xl border cursor-pointer transition-colors ${
                  selectedTemplate?.id === tmpl.id
                    ? 'bg-indigo-900/30 border-indigo-700'
                    : 'bg-gray-900 border-gray-800 hover:border-gray-700'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-medium text-white">{tmpl.display_name}</p>
                    <p className="text-xs text-gray-500 mt-0.5 font-mono">{tmpl.name}</p>
                  </div>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${tmpl.is_active ? 'bg-green-900/40 text-green-300' : 'bg-gray-700 text-gray-500'}`}>
                    {tmpl.is_active ? t('serviceTemplates.statusActive') : t('serviceTemplates.statusInactive')}
                  </span>
                </div>
                {tmpl.service_type && (
                  <p className="text-xs text-gray-500 mt-1">{t(`serviceTemplates.types.${tmpl.service_type}`, { defaultValue: tmpl.service_type.replace(/_/g, ' ') })}</p>
                )}
                <div className="flex items-center justify-between mt-2">
                  <span className="text-xs text-indigo-400">{t('serviceTemplates.ciTypesCount', { count: tmpl.item_count })}</span>
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
                      className="text-xs text-blue-400 hover:text-blue-300"
                    >{t('common.edit')}</button>
                    <button
                      onClick={e => {
                        e.stopPropagation()
                        if (confirm(t('serviceTemplates.confirmDeleteTemplate', { name: tmpl.display_name }))) deleteTemplate.mutate(tmpl.id)
                      }}
                      className="text-xs text-red-400 hover:text-red-300"
                    >{t('common.delete')}</button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Detail Panel */}
        {selectedTemplate ? (
          <div className="flex-1 bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">{selectedTemplate.display_name}</h2>
              <button
                onClick={() => setShowItemForm(true)}
                className="text-xs px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg"
              >
                {t('serviceTemplates.addCiType')}
              </button>
            </div>
            {selectedTemplate.description && (
              <p className="text-sm text-gray-400">{selectedTemplate.description}</p>
            )}
            {selectedTemplate.tags && selectedTemplate.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {selectedTemplate.tags.map(tag => (
                  <span key={tag} className="text-xs px-2 py-0.5 bg-gray-800 text-gray-400 rounded-full">{tag}</span>
                ))}
              </div>
            )}

            {/* Add Item Form */}
            {showItemForm && (
              <div className="bg-gray-800 rounded-xl border border-gray-700 p-4 space-y-3">
                <h3 className="text-sm font-semibold text-white">{t('serviceTemplates.addCiTypeTitle')}</h3>
                {iError && <p className="text-red-400 text-xs">{iError}</p>}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">{t('serviceTemplates.ciType')}</label>
                    <select
                      value={iCITypeId}
                      onChange={e => setICITypeId(e.target.value)}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                    >
                      <option value="">{t('serviceTemplates.select')}</option>
                      {ciTypes.map(ct => (
                        <option key={ct.id} value={ct.id}>{ct.display_name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">{t('serviceTemplates.role')}</label>
                    <input
                      value={iRole}
                      onChange={e => setIRole(e.target.value)}
                      placeholder={t('serviceTemplates.rolePlaceholder')}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">{t('serviceTemplates.minCount')}</label>
                    <input
                      type="number"
                      value={iMin}
                      min={0}
                      onChange={e => setIMin(Number(e.target.value))}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">{t('serviceTemplates.maxCountLabel')}</label>
                    <input
                      type="number"
                      value={iMax}
                      min={1}
                      onChange={e => setIMax(e.target.value)}
                      placeholder={t('serviceTemplates.unlimited')}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                    />
                  </div>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={iRequired} onChange={e => setIRequired(e.target.checked)} className="w-4 h-4" />
                  <span className="text-sm text-gray-300">{t('serviceTemplates.required')}</span>
                </label>
                <div className="flex gap-2">
                  <button
                    disabled={addItem.isPending || !iCITypeId}
                    onClick={() => addItem.mutate()}
                    className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs rounded-lg"
                  >
                    {addItem.isPending ? t('serviceTemplates.adding') : t('serviceTemplates.add')}
                  </button>
                  <button
                    onClick={() => { setShowItemForm(false); setIError('') }}
                    className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded-lg"
                  >{t('common.cancel')}</button>
                </div>
              </div>
            )}

            {/* Items Table */}
            {templateDetail?.items && templateDetail.items.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 border-b border-gray-800">
                    <th className="text-left py-2">{t('serviceTemplates.ciType')}</th>
                    <th className="text-left py-2">{t('serviceTemplates.role')}</th>
                    <th className="text-center py-2">{t('serviceTemplates.required')}</th>
                    <th className="text-center py-2">{t('serviceTemplates.count')}</th>
                    <th className="text-right py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {templateDetail.items.map(item => (
                    <tr key={item.id} className="border-b border-gray-800/40">
                      <td className="py-2 text-white">{item.ci_type_display}</td>
                      <td className="py-2 text-gray-400 text-xs">{item.role ?? '—'}</td>
                      <td className="py-2 text-center">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${item.is_required ? 'bg-red-900/40 text-red-300' : 'bg-gray-700 text-gray-400'}`}>
                          {item.is_required ? t('serviceTemplates.requiredBadge') : t('serviceTemplates.optionalBadge')}
                        </span>
                      </td>
                      <td className="py-2 text-center text-gray-400 text-xs">
                        {item.min_count}–{item.max_count ?? '∞'}
                      </td>
                      <td className="py-2 text-right">
                        <button
                          onClick={() => { if (confirm(t('serviceTemplates.confirmRemoveItem'))) removeItem.mutate(item.id) }}
                          className="text-xs text-red-400 hover:text-red-300"
                        >{t('serviceTemplates.remove')}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="text-center py-10 text-gray-600 text-sm">
                {t('serviceTemplates.noItems')}
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
            {t('serviceTemplates.selectTemplate')}
          </div>
        )}
      </div>
    </div>
  )
}
