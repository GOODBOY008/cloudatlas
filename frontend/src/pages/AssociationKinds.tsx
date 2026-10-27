import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'

interface AssociationKind {
  id: string
  organization_id: string | null
  name: string
  display_name: string
  description?: string
  is_directional: boolean
  is_builtin: boolean
  usage_count: number
  created_at: string
}

interface ObjectAssociation {
  id: string
  src_ci_type_id: string
  src_type_name: string
  src_type_display: string
  association_kind_id: string
  kind_name: string
  kind_display: string
  is_directional: boolean
  dst_ci_type_id: string
  dst_type_name: string
  dst_type_display: string
  cardinality: string
  description?: string
  instance_count: number
}

interface CIType {
  id: string
  name: string
  display_name: string
}

const CARDINALITIES = ['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many']

export default function AssociationKinds() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const [activeTab, setActiveTab] = useState<'kinds' | 'mappings'>('kinds')

  // Kind form
  const [showKindForm, setShowKindForm] = useState(false)
  const [editKindId, setEditKindId] = useState<string | null>(null)
  const [kindName, setKindName] = useState('')
  const [kindDisplay, setKindDisplay] = useState('')
  const [kindDesc, setKindDesc] = useState('')
  const [kindDirectional, setKindDirectional] = useState(true)
  const [kindError, setKindError] = useState('')

  // Mapping form
  const [showMappingForm, setShowMappingForm] = useState(false)
  const [mapSrcType, setMapSrcType] = useState('')
  const [mapKindId, setMapKindId] = useState('')
  const [mapDstType, setMapDstType] = useState('')
  const [mapCardinality, setMapCardinality] = useState('many_to_many')
  const [mapDesc, setMapDesc] = useState('')
  const [mapError, setMapError] = useState('')

  const { data: kinds = [], isLoading: loadingKinds } = useQuery<AssociationKind[]>({
    queryKey: ['association-kinds', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: AssociationKind[] }>(
        `/orgs/${orgId}/ci-association-kinds`
      )
      return res.data ?? []
    },
  })

  const { data: mappings = [], isLoading: loadingMappings } = useQuery<ObjectAssociation[]>({
    queryKey: ['object-associations', orgId],
    enabled: !!orgId && activeTab === 'mappings',
    queryFn: async () => {
      const { data: res } = await api.get<{ data: ObjectAssociation[] }>(
        `/orgs/${orgId}/ci-object-associations`
      )
      return res.data ?? []
    },
  })

  const { data: ciTypes = [] } = useQuery<CIType[]>({
    queryKey: ['ci-types-list', orgId],
    enabled: !!orgId && (showMappingForm || activeTab === 'mappings'),
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CIType[] }>(`/orgs/${orgId}/ci-types`)
      return res.data ?? []
    },
  })

  function resetKindForm() {
    setKindName(''); setKindDisplay(''); setKindDesc('')
    setKindDirectional(true); setEditKindId(null)
    setKindError(''); setShowKindForm(false)
  }

  const createKindMutation = useMutation({
    mutationFn: () =>
      api.post(`/orgs/${orgId}/ci-association-kinds`, {
        name: kindName.trim(),
        display_name: kindDisplay.trim(),
        description: kindDesc.trim() || undefined,
        is_directional: kindDirectional,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['association-kinds', orgId] })
      resetKindForm()
    },
    onError: () => setKindError(t('assocKinds.createKindFailed')),
  })

  const updateKindMutation = useMutation({
    mutationFn: () =>
      api.put(`/orgs/${orgId}/ci-association-kinds/${editKindId}`, {
        display_name: kindDisplay.trim(),
        description: kindDesc.trim() || undefined,
        is_directional: kindDirectional,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['association-kinds', orgId] })
      resetKindForm()
    },
    onError: () => setKindError(t('assocKinds.updateKindFailed')),
  })

  const deleteKindMutation = useMutation({
    mutationFn: (id: string) =>
      api.delete(`/orgs/${orgId}/ci-association-kinds/${id}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['association-kinds', orgId] }),
    onError: (err: unknown) => alert((err as Error)?.message ?? t('assocKinds.deleteInUse')),
  })

  const createMappingMutation = useMutation({
    mutationFn: () =>
      api.post(`/orgs/${orgId}/ci-object-associations`, {
        src_ci_type_id: mapSrcType,
        association_kind_id: mapKindId,
        dst_ci_type_id: mapDstType,
        cardinality: mapCardinality,
        description: mapDesc.trim() || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['object-associations', orgId] })
      setShowMappingForm(false)
      setMapSrcType(''); setMapKindId(''); setMapDstType('')
      setMapCardinality('many_to_many'); setMapDesc(''); setMapError('')
    },
    onError: () => setMapError(t('assocKinds.createMappingFailed')),
  })

  const deleteMappingMutation = useMutation({
    mutationFn: (id: string) =>
      api.delete(`/orgs/${orgId}/ci-object-associations/${id}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['object-associations', orgId] }),
    onError: (err: unknown) => alert((err as Error)?.message ?? t('assocKinds.deleteInUse')),
  })

  const kindBusy = createKindMutation.isPending || updateKindMutation.isPending

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-title">{t('assocKinds.title')}</h1>
          <p className="text-sm text-secondary mt-0.5">
            {t('assocKinds.subtitle')}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-subtle/60 p-1 rounded-lg w-fit">
        {(['kinds', 'mappings'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-1.5 text-sm rounded-md font-medium transition-colors capitalize ${
              activeTab === tab
                ? 'bg-emphasis text-primary'
                : 'text-secondary hover:text-primary'
            }`}
          >
            {tab === 'kinds' ? t('assocKinds.title') : t('assocKinds.tabMappings')}
          </button>
        ))}
      </div>

      {/* ─── Association Kinds Tab ─── */}
      {activeTab === 'kinds' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={() => { resetKindForm(); setShowKindForm(true) }}
              className="px-4 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm font-medium rounded-lg"
            >
              {t('assocKinds.newKind')}
            </button>
          </div>

          {showKindForm && (
            <div className="bg-subtle rounded-xl border border-strong p-5 space-y-4">
              <h2 className="text-base font-semibold text-primary">
                {editKindId ? t('assocKinds.editKind') : t('assocKinds.newKindTitle')}
              </h2>
              {kindError && <p className="text-danger text-sm">{kindError}</p>}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-secondary mb-1">{t('assocKinds.nameKey')}</label>
                  <input
                    value={kindName}
                    onChange={e => setKindName(e.target.value)}
                    disabled={!!editKindId}
                    placeholder={t('assocKinds.namePlaceholder')}
                    className="w-full bg-surface border border-strong rounded-lg px-3 py-2 text-sm text-primary disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="block text-xs text-secondary mb-1">{t('cmdb.displayName')}</label>
                  <input
                    value={kindDisplay}
                    onChange={e => setKindDisplay(e.target.value)}
                    placeholder={t('assocKinds.displayPlaceholder')}
                    className="w-full bg-surface border border-strong rounded-lg px-3 py-2 text-sm text-primary"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-secondary mb-1">{t('common.description')}</label>
                <input
                  value={kindDesc}
                  onChange={e => setKindDesc(e.target.value)}
                  placeholder={t('assocKinds.optionalDesc')}
                  className="w-full bg-surface border border-strong rounded-lg px-3 py-2 text-sm text-primary"
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={kindDirectional}
                  onChange={e => setKindDirectional(e.target.checked)}
                  className="w-4 h-4"
                />
                <span className="text-sm text-secondary">
                  {t('assocKinds.directional')}
                </span>
              </label>
              <div className="flex gap-3">
                <button
                  disabled={kindBusy || !kindName.trim() || !kindDisplay.trim()}
                  onClick={() => editKindId ? updateKindMutation.mutate() : createKindMutation.mutate()}
                  className="px-4 py-2 bg-accent hover:bg-accent-hover disabled:opacity-50 text-on-accent text-sm font-medium rounded-lg"
                >
                  {kindBusy ? t('assocKinds.saving') : editKindId ? t('assocKinds.update') : t('assocKinds.create')}
                </button>
                <button onClick={resetKindForm} className="px-4 py-2 bg-emphasis hover:bg-emphasis text-primary text-sm rounded-lg">
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}

          {loadingKinds ? (
            <p className="text-muted text-sm">{t('common.loading')}</p>
          ) : (
            <div className="bg-surface rounded-xl border border-edge overflow-hidden">
              <div className="table-scroll" tabIndex={0}><table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted border-b border-edge">
                    <th className="text-left px-4 py-3">{t('common.name')}</th>
                    <th className="text-left px-4 py-3">{t('assocKinds.colDisplay')}</th>
                    <th className="text-left px-4 py-3">{t('assocKinds.colDirection')}</th>
                    <th className="text-right px-4 py-3">{t('assocKinds.colUsedIn')}</th>
                    <th className="text-right px-4 py-3">{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {kinds.map(k => (
                    <tr key={k.id} className="border-b border-edge/60 hover:bg-subtle/30">
                      <td className="px-4 py-3 font-mono text-xs text-primary">
                        {k.name}
                        {k.is_builtin && (
                          <span className="ml-2 px-1.5 py-0.5 bg-emphasis text-secondary text-xs rounded">{t('assocKinds.builtin')}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-primary">{k.display_name}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${k.is_directional ? 'bg-info/10 text-info' : 'bg-emphasis text-secondary'}`}>
                          {k.is_directional ? t('assocKinds.directionalBadge') : t('assocKinds.bidirectionalBadge')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-accent font-medium">{k.usage_count}</td>
                      <td className="px-4 py-3 text-right">
                        {!k.is_builtin && (
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => {
                                setEditKindId(k.id); setKindName(k.name)
                                setKindDisplay(k.display_name); setKindDesc(k.description ?? '')
                                setKindDirectional(k.is_directional); setShowKindForm(true)
                              }}
                              className="text-xs text-info hover:text-info"
                            >{t('common.edit')}</button>
                            <button
                              onClick={() => { if (confirm(t('assocKinds.deleteKindConfirm', { name: k.display_name }))) deleteKindMutation.mutate(k.id) }}
                              className="text-xs text-danger hover:text-danger"
                            >{t('common.delete')}</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </div>
          )}
        </div>
      )}

      {/* ─── Type Mappings Tab ─── */}
      {activeTab === 'mappings' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={() => setShowMappingForm(true)}
              className="px-4 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm font-medium rounded-lg"
            >
              {t('assocKinds.newMapping')}
            </button>
          </div>

          {showMappingForm && (
            <div className="bg-subtle rounded-xl border border-strong p-5 space-y-4">
              <h2 className="text-base font-semibold text-primary">{t('assocKinds.newMappingTitle')}</h2>
              {mapError && <p className="text-danger text-sm">{mapError}</p>}
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-secondary mb-1">{t('assocKinds.srcType')}</label>
                  <select
                    value={mapSrcType}
                    onChange={e => setMapSrcType(e.target.value)}
                    className="w-full bg-surface border border-strong rounded-lg px-3 py-2 text-sm text-primary"
                  >
                    <option value="">{t('assocKinds.selectType')}</option>
                    {ciTypes.map(t => (
                      <option key={t.id} value={t.id}>{t.display_name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-secondary mb-1">{t('assocKinds.kind')}</label>
                  <select
                    value={mapKindId}
                    onChange={e => setMapKindId(e.target.value)}
                    className="w-full bg-surface border border-strong rounded-lg px-3 py-2 text-sm text-primary"
                  >
                    <option value="">{t('assocKinds.selectKind')}</option>
                    {kinds.map(k => (
                      <option key={k.id} value={k.id}>{k.display_name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-secondary mb-1">{t('assocKinds.dstType')}</label>
                  <select
                    value={mapDstType}
                    onChange={e => setMapDstType(e.target.value)}
                    className="w-full bg-surface border border-strong rounded-lg px-3 py-2 text-sm text-primary"
                  >
                    <option value="">{t('assocKinds.selectType')}</option>
                    {ciTypes.map(t => (
                      <option key={t.id} value={t.id}>{t.display_name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-secondary mb-1">{t('assocKinds.cardinality')}</label>
                  <select
                    value={mapCardinality}
                    onChange={e => setMapCardinality(e.target.value)}
                    className="w-full bg-surface border border-strong rounded-lg px-3 py-2 text-sm text-primary"
                  >
                    {CARDINALITIES.map(c => (
                      <option key={c} value={c}>{c.replace(/_/g, ':')}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-secondary mb-1">{t('common.description')}</label>
                  <input
                    value={mapDesc}
                    onChange={e => setMapDesc(e.target.value)}
                    className="w-full bg-surface border border-strong rounded-lg px-3 py-2 text-sm text-primary"
                  />
                </div>
              </div>
              <div className="flex gap-3">
                <button
                  disabled={createMappingMutation.isPending || !mapSrcType || !mapKindId || !mapDstType}
                  onClick={() => createMappingMutation.mutate()}
                  className="px-4 py-2 bg-accent hover:bg-accent-hover disabled:opacity-50 text-on-accent text-sm font-medium rounded-lg"
                >
                  {createMappingMutation.isPending ? t('assocKinds.saving') : t('assocKinds.createMapping')}
                </button>
                <button
                  onClick={() => { setShowMappingForm(false); setMapError('') }}
                  className="px-4 py-2 bg-emphasis hover:bg-emphasis text-primary text-sm rounded-lg"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}

          {loadingMappings ? (
            <p className="text-muted text-sm">{t('common.loading')}</p>
          ) : (
            <div className="bg-surface rounded-xl border border-edge overflow-hidden">
              <div className="table-scroll" tabIndex={0}><table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted border-b border-edge">
                    <th className="text-left px-4 py-3">{t('assocKinds.colSrcType')}</th>
                    <th className="text-center px-4 py-3">{t('assocKinds.colRelation')}</th>
                    <th className="text-left px-4 py-3">{t('assocKinds.colDstType')}</th>
                    <th className="text-left px-4 py-3">{t('assocKinds.cardinality')}</th>
                    <th className="text-right px-4 py-3">{t('assocKinds.colInstances')}</th>
                    <th className="text-right px-4 py-3">{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.map(m => (
                    <tr key={m.id} className="border-b border-edge/60 hover:bg-subtle/30">
                      <td className="px-4 py-3 text-primary">{m.src_type_display}</td>
                      <td className="px-4 py-3 text-center">
                        <span className="text-xs px-2 py-0.5 bg-accent-soft/30 text-accent rounded-full">
                          {m.is_directional ? `→ ${m.kind_display}` : `↔ ${m.kind_display}`}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-primary">{m.dst_type_display}</td>
                      <td className="px-4 py-3 text-secondary text-xs">{m.cardinality.replace(/_/g, ':')}</td>
                      <td className="px-4 py-3 text-right text-accent font-medium">{m.instance_count}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => { if (confirm(t('assocKinds.deleteMappingConfirm'))) deleteMappingMutation.mutate(m.id) }}
                          className="text-xs text-danger hover:text-danger"
                        >
                          {t('common.delete')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
