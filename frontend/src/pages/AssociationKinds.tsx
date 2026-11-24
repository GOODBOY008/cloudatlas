import { Table } from '@cloudflare/kumo/components/table'
import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
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
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('assocKinds.title')}</h1>
          <p className="text-sm text-secondary mt-0.5">
            {t('assocKinds.subtitle')}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="segmented-control ">
        {(['kinds', 'mappings'] as const).map(tab => (
          <button aria-pressed={activeTab === tab}
            key={tab}
            onClick={() => setActiveTab(tab)}
            className="segment"
          >
            {tab === 'kinds' ? t('assocKinds.title') : t('assocKinds.tabMappings')}
          </button>
        ))}
      </div>

      {/* ─── Association Kinds Tab ─── */}
      {activeTab === 'kinds' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={() => { resetKindForm(); setShowKindForm(true) }}
            >
              {t('assocKinds.newKind')}
            </Button>
          </div>

          {showKindForm && (
            <div className="bg-subtle rounded-xl border border-strong p-5 space-y-4">
              <h2 className="text-base font-semibold text-primary">
                {editKindId ? t('assocKinds.editKind') : t('assocKinds.newKindTitle')}
              </h2>
              {kindError && <p className="text-danger text-sm">{kindError}</p>}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Input
                    label={t('assocKinds.nameKey')}
                    value={kindName}
                    onChange={e => setKindName(e.target.value)}
                    disabled={!!editKindId}
                    placeholder={t('assocKinds.namePlaceholder')}
                    className="w-full"
                  />
                </div>
                <div>
                  <Input
                    label={t('cmdb.displayName')}
                    value={kindDisplay}
                    onChange={e => setKindDisplay(e.target.value)}
                    placeholder={t('assocKinds.displayPlaceholder')}
                    className="w-full"
                  />
                </div>
              </div>
              <div>
                <Input
                  label={t('common.description')}
                  value={kindDesc}
                  onChange={e => setKindDesc(e.target.value)}
                  placeholder={t('assocKinds.optionalDesc')}
                  className="w-full"
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
                <Button
                  variant="primary"
                  disabled={kindBusy || !kindName.trim() || !kindDisplay.trim()}
                  onClick={() => editKindId ? updateKindMutation.mutate() : createKindMutation.mutate()}
                >
                  {kindBusy ? t('assocKinds.saving') : editKindId ? t('assocKinds.update') : t('assocKinds.create')}
                </Button>
                <Button onClick={resetKindForm}>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          )}

          {loadingKinds ? (
            <p className="text-muted text-sm">{t('common.loading')}</p>
          ) : (
            <div className="bg-surface rounded-xl border border-edge overflow-hidden">
              <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
                <Table.Header variant="compact">
                  <Table.Row className="text-xs text-muted border-b border-edge">
                    <Table.Head className="text-left px-4 py-3">{t('common.name')}</Table.Head>
                    <Table.Head className="text-left px-4 py-3">{t('assocKinds.colDisplay')}</Table.Head>
                    <Table.Head className="text-left px-4 py-3">{t('assocKinds.colDirection')}</Table.Head>
                    <Table.Head className="text-right px-4 py-3">{t('assocKinds.colUsedIn')}</Table.Head>
                    <Table.Head className="text-right px-4 py-3">{t('common.actions')}</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {kinds.map(k => (
                    <Table.Row key={k.id} className="border-b border-edge/60 hover:bg-subtle/30">
                      <Table.Cell className="px-4 py-3 font-mono text-xs text-primary">
                        {k.name}
                        {k.is_builtin && (
                          <span className="ml-2 px-1.5 py-0.5 bg-emphasis text-secondary text-xs rounded">{t('assocKinds.builtin')}</span>
                        )}
                      </Table.Cell>
                      <Table.Cell className="px-4 py-3 text-primary">{k.display_name}</Table.Cell>
                      <Table.Cell className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${k.is_directional ? 'bg-info/10 text-info' : 'bg-emphasis text-secondary'}`}>
                          {k.is_directional ? t('assocKinds.directionalBadge') : t('assocKinds.bidirectionalBadge')}
                        </span>
                      </Table.Cell>
                      <Table.Cell className="px-4 py-3 text-right text-accent font-medium">{k.usage_count}</Table.Cell>
                      <Table.Cell className="px-4 py-3 text-right">
                        {!k.is_builtin && (
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm" variant="ghost"
                              onClick={() => {
                                setEditKindId(k.id); setKindName(k.name)
                                setKindDisplay(k.display_name); setKindDesc(k.description ?? '')
                                setKindDirectional(k.is_directional); setShowKindForm(true)
                              }}
                            >{t('common.edit')}</Button>
                            <Button
                              size="sm" variant="secondary-destructive"
                              onClick={() => { if (confirm(t('assocKinds.deleteKindConfirm', { name: k.display_name }))) deleteKindMutation.mutate(k.id) }}
                            >{t('common.delete')}</Button>
                          </div>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table></div>
            </div>
          )}
        </div>
      )}

      {/* ─── Type Mappings Tab ─── */}
      {activeTab === 'mappings' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={() => setShowMappingForm(true)}
            >
              {t('assocKinds.newMapping')}
            </Button>
          </div>

          {showMappingForm && (
            <div className="bg-subtle rounded-xl border border-strong p-5 space-y-4">
              <h2 className="text-base font-semibold text-primary">{t('assocKinds.newMappingTitle')}</h2>
              {mapError && <p className="text-danger text-sm">{mapError}</p>}
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <SelectField
                    label={t('assocKinds.srcType')}
                    value={mapSrcType}
                    onValueChange={setMapSrcType}
                    className="w-full"
                    items={[
                      { value: "", label: t('assocKinds.selectType') },
                      ...ciTypes.map(t => ({ value: t.id, label: t.display_name })),
                    ]}
                  />
                </div>
                <div>
                  <SelectField
                    label={t('assocKinds.kind')}
                    value={mapKindId}
                    onValueChange={setMapKindId}
                    className="w-full"
                    items={[
                      { value: "", label: t('assocKinds.selectKind') },
                      ...kinds.map(k => ({ value: k.id, label: k.display_name })),
                    ]}
                  />
                </div>
                <div>
                  <SelectField
                    label={t('assocKinds.dstType')}
                    value={mapDstType}
                    onValueChange={setMapDstType}
                    className="w-full"
                    items={[
                      { value: "", label: t('assocKinds.selectType') },
                      ...ciTypes.map(t => ({ value: t.id, label: t.display_name })),
                    ]}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <SelectField
                    label={t('assocKinds.cardinality')}
                    value={mapCardinality}
                    onValueChange={setMapCardinality}
                    className="w-full"
                    items={CARDINALITIES.map(c => ({ value: c, label: c.replace(/_/g, ':') }))}
                  />
                </div>
                <div>
                  <Input
                    label={t('common.description')}
                    value={mapDesc}
                    onChange={e => setMapDesc(e.target.value)}
                    className="w-full"
                  />
                </div>
              </div>
              <div className="flex gap-3">
                <Button
                  variant="primary"
                  disabled={createMappingMutation.isPending || !mapSrcType || !mapKindId || !mapDstType}
                  onClick={() => createMappingMutation.mutate()}
                >
                  {createMappingMutation.isPending ? t('assocKinds.saving') : t('assocKinds.createMapping')}
                </Button>
                <Button
                  onClick={() => { setShowMappingForm(false); setMapError('') }}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          )}

          {loadingMappings ? (
            <p className="text-muted text-sm">{t('common.loading')}</p>
          ) : (
            <div className="bg-surface rounded-xl border border-edge overflow-hidden">
              <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
                <Table.Header variant="compact">
                  <Table.Row className="text-xs text-muted border-b border-edge">
                    <Table.Head className="text-left px-4 py-3">{t('assocKinds.colSrcType')}</Table.Head>
                    <Table.Head className="text-center px-4 py-3">{t('assocKinds.colRelation')}</Table.Head>
                    <Table.Head className="text-left px-4 py-3">{t('assocKinds.colDstType')}</Table.Head>
                    <Table.Head className="text-left px-4 py-3">{t('assocKinds.cardinality')}</Table.Head>
                    <Table.Head className="text-right px-4 py-3">{t('assocKinds.colInstances')}</Table.Head>
                    <Table.Head className="text-right px-4 py-3">{t('common.actions')}</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {mappings.map(m => (
                    <Table.Row key={m.id} className="border-b border-edge/60 hover:bg-subtle/30">
                      <Table.Cell className="px-4 py-3 text-primary">{m.src_type_display}</Table.Cell>
                      <Table.Cell className="px-4 py-3 text-center">
                        <span className="text-xs px-2 py-0.5 bg-accent-soft/30 text-accent rounded-full">
                          {m.is_directional ? `→ ${m.kind_display}` : `↔ ${m.kind_display}`}
                        </span>
                      </Table.Cell>
                      <Table.Cell className="px-4 py-3 text-primary">{m.dst_type_display}</Table.Cell>
                      <Table.Cell className="px-4 py-3 text-secondary text-xs">{m.cardinality.replace(/_/g, ':')}</Table.Cell>
                      <Table.Cell className="px-4 py-3 text-right text-accent font-medium">{m.instance_count}</Table.Cell>
                      <Table.Cell className="px-4 py-3 text-right">
                        <Button
                          size="sm" variant="secondary-destructive"
                          onClick={() => { if (confirm(t('assocKinds.deleteMappingConfirm'))) deleteMappingMutation.mutate(m.id) }}
                        >
                          {t('common.delete')}
                        </Button>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table></div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
