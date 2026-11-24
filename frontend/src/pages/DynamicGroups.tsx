import { Table } from '@cloudflare/kumo/components/table'
import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { NativeDialog } from '../components/shared/NativeDialog'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { Modal } from '../components/shared/Modal'

interface DynamicGroup {
  id: string
  name: string
  description?: string
  ci_type_id?: string
  conditions: Condition[]
  created_at: string
}

interface Condition {
  field: string
  operator: string
  value: string
}

interface ExecuteResult {
  matched: number
  cis: { id: string; name: string; display_name?: string; lifecycle_state: string; ci_type_name?: string }[]
}

const OPERATOR_LABELS: Record<string, string> = {
  eq: '=',
  ne: '≠',
  gt: '>',
  lt: '<',
  gte: '≥',
  lte: '≤',
}

const OPERATOR_T_KEYS: Record<string, string> = {
  contains: 'dynamicGroups.opContains',
  not_contains: 'dynamicGroups.opNotContains',
  in: 'dynamicGroups.opIn',
  starts_with: 'dynamicGroups.opStartsWith',
}

const OPERATORS = Object.keys(OPERATOR_LABELS)
const COMMON_FIELDS = ['lifecycle_state', 'cloud_provider', 'cloud_region', 'name', 'display_name']

const LIFECYCLE_STATE_COLORS: Record<string, string> = {
  active: 'text-success',
  decommissioned: 'text-danger',
  maintenance: 'text-warning',
  provisioning: 'text-info',
}

function GroupResultPanel({
  groupId,
  groupName,
  onClose,
}: {
  groupId: string
  groupName: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const { data: result, isLoading, isError } = useQuery<ExecuteResult>({
    queryKey: ['dg-execute', orgId, groupId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.post<{ data: ExecuteResult }>(
        `/orgs/${orgId}/ci-groups/${groupId}/execute`,
        {}
      )
      return res.data ?? { matched: 0, cis: [] }
    },
    retry: false,
  })

  return (
    <NativeDialog className="justify-end" label={groupName} onClose={onClose}>

      <div className="drawer-panel max-w-[480px]">
        <div className="flex items-start justify-between p-5 border-b border-edge sticky top-0 bg-surface">
          <div>
            <h2 className="text-lg font-semibold text-primary">{groupName}</h2>
            <p className="text-xs text-muted mt-0.5">{t('dynamicGroups.executionResults')}</p>
          </div>
          <Button variant="ghost" shape="square" onClick={onClose} aria-label={t('common.close')}>✕</Button>
        </div>

        <div className="p-5">
          {isLoading && <p className="text-muted text-sm">{t('dynamicGroups.runningFilter')}</p>}
          {isError && <p className="text-danger text-sm">{t('dynamicGroups.executeFailed')}</p>}
          {result && (
            <>
              <p className="text-sm text-secondary mb-4">
                {result.matched === 1
                  ? t('dynamicGroups.matchedSingle', { count: result.matched })
                  : t('dynamicGroups.matchedPlural', { count: result.matched })}
              </p>
              {result.cis.length === 0 ? (
                <p className="text-muted text-sm">{t('dynamicGroups.noCisMatched')}</p>
              ) : (
                <div className="bg-subtle/50 rounded-lg overflow-hidden">
                  <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
                    <Table.Header variant="compact">
                      <Table.Row className="text-muted text-xs border-b border-strong">
                        <Table.Head className="px-3 py-2 text-left">{t('cmdb.colCi')}</Table.Head>
                        <Table.Head className="px-3 py-2 text-left">{t('common.type')}</Table.Head>
                        <Table.Head className="px-3 py-2 text-left">{t('dynamicGroups.colState')}</Table.Head>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {result.cis.map(c => (
                        <Table.Row key={c.id} className="border-b border-strong/50 last:border-0">
                          <Table.Cell className="px-3 py-2">
                            <p className="text-primary font-medium">{c.display_name || c.name}</p>
                            <p className="text-muted text-xs">{c.name}</p>
                          </Table.Cell>
                          <Table.Cell className="px-3 py-2 text-secondary text-xs">{c.ci_type_name ?? '—'}</Table.Cell>
                          <Table.Cell className="px-3 py-2">
                            <span className={`text-xs ${LIFECYCLE_STATE_COLORS[c.lifecycle_state] ?? 'text-secondary'}`}>
                              {t(`lifecycle.${c.lifecycle_state}`, { defaultValue: c.lifecycle_state })}
                            </span>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table></div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </NativeDialog>
  )
}

export default function DynamicGroups() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const [showForm, setShowForm] = useState(false)
  const [formError, setFormError] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [conditions, setConditions] = useState<Condition[]>([{ field: 'lifecycle_state', operator: 'eq', value: '' }])
  const [selectedGroup, setSelectedGroup] = useState<{ id: string; name: string } | null>(null)
  const [editGroup, setEditGroup] = useState<DynamicGroup | null>(null)
  const [editGroupName, setEditGroupName] = useState('')
  const [editGroupDescription, setEditGroupDescription] = useState('')

  const { data: groups = [], isLoading } = useQuery<DynamicGroup[]>({
    queryKey: ['dynamic-groups', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: DynamicGroup[] }>(`/orgs/${orgId}/ci-groups`)
      return res.data ?? []
    },
  })

  const createMutation = useMutation({
    mutationFn: () =>
      api.post(`/orgs/${orgId}/ci-groups`, {
        name: name.trim(),
        description: description.trim() || undefined,
        conditions,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dynamic-groups', orgId] })
      setShowForm(false)
      setName('')
      setDescription('')
      setConditions([{ field: 'lifecycle_state', operator: 'eq', value: '' }])
      setFormError('')
    },
    onError: () => setFormError(t('dynamicGroups.createFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/ci-groups/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dynamic-groups', orgId] }),
  })

  const updateMutation = useMutation({
    mutationFn: (payload: { id: string; name: string; description?: string; conditions: Condition[] }) =>
      api.put(`/orgs/${orgId}/ci-groups/${payload.id}`, {
        name: payload.name,
        description: payload.description,
        conditions: payload.conditions,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dynamic-groups', orgId] }),
  })

  const addCondition = () =>
    setConditions(c => [...c, { field: 'lifecycle_state', operator: 'eq', value: '' }])

  const removeCondition = (i: number) =>
    setConditions(c => c.filter((_, idx) => idx !== i))

  const updateCondition = (i: number, patch: Partial<Condition>) =>
    setConditions(c => c.map((cond, idx) => (idx === i ? { ...cond, ...patch } : cond)))

  const opLabel = (op: string) =>
    OPERATOR_T_KEYS[op] ? t(OPERATOR_T_KEYS[op]) : (OPERATOR_LABELS[op] ?? op)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) { setFormError(t('dynamicGroups.nameRequired')); return }
    if (conditions.some(c => !c.value.trim())) { setFormError(t('dynamicGroups.conditionValuesRequired')); return }
    createMutation.mutate()
  }

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('dynamicGroups.title')}</h1>
          <p className="text-sm text-secondary mt-1">{t('dynamicGroups.subtitle')}</p>
        </div>
        <Button
          variant={showForm ? 'secondary' : 'primary'}
          onClick={() => setShowForm(v => !v)}
        >
          {showForm ? t('common.cancel') : t('dynamicGroups.newGroup')}
        </Button>
      </div>

      {/* Create form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-subtle rounded-xl p-5 mb-6 space-y-4">
          <h2 className="text-sm font-semibold text-primary">{t('dynamicGroups.createTitle')}</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Input
                label={`${t('common.name')} *`}
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full"
                placeholder="active-vms"
              />
            </div>
            <div>
              <Input
                label={t('common.description')}
                type="text"
                value={description}
                onChange={e => setDescription(e.target.value)}
                className="w-full"
                placeholder={t('dynamicGroups.descPlaceholder')}
              />
            </div>
          </div>

          {/* Conditions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-secondary">{t('dynamicGroups.conditionsAll')}</label>
              <button
                type="button"
                onClick={addCondition}
                className="text-xs text-accent hover:text-accent"
              >
                {t('dynamicGroups.addCondition')}
              </button>
            </div>
            <div className="space-y-2">
              {conditions.map((cond, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <Input
                    aria-label={t('dynamicGroups.fieldPlaceholder')}
                    list={`fields-${i}`}
                    value={cond.field}
                    onChange={e => updateCondition(i, { field: e.target.value })}
                    className="flex-1"
                    placeholder={t('dynamicGroups.fieldPlaceholder')}
                  />
                  <datalist id={`fields-${i}`}>
                    {COMMON_FIELDS.map(f => <option key={f} value={f} />)}
                  </datalist>
                  <SelectField
                    aria-label={t('common.operator')}
                    value={cond.operator}
                    onValueChange={value => updateCondition(i, { operator: value })}
                    items={OPERATORS.map(op => ({ value: op, label: opLabel(op) }))}
                  />
                  <Input
                    aria-label={t('dynamicGroups.valuePlaceholder')}
                    value={cond.value}
                    onChange={e => updateCondition(i, { value: e.target.value })}
                    className="flex-1"
                    placeholder={t('dynamicGroups.valuePlaceholder')}
                  />
                  {conditions.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeCondition(i)}
                      className="text-danger/70 hover:text-danger text-xs"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {formError && <p className="text-sm text-danger">{formError}</p>}
          <div className="flex justify-end gap-3">
            <Button
              variant="ghost"
              type="button"
              onClick={() => { setShowForm(false); setFormError('') }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? t('dynamicGroups.creating') : t('dynamicGroups.createGroup')}
            </Button>
          </div>
        </form>
      )}

      {/* Groups list */}
      {isLoading ? (
        <div className="text-center py-20 text-muted">{t('dynamicGroups.loadingGroups')}</div>
      ) : groups.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-4xl mb-3">🎯</p>
          <p className="text-secondary text-lg font-medium">{t('dynamicGroups.noGroups')}</p>
          <p className="text-muted text-sm mt-1">{t('dynamicGroups.noGroupsHint')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map(g => (
            <div key={g.id} className="bg-subtle rounded-xl p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <p className="text-primary font-medium">{g.name}</p>
                  {g.description && (
                    <p className="text-secondary text-sm mt-0.5">{g.description}</p>
                  )}
                  {/* Conditions summary */}
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {(g.conditions ?? []).map((c, i) => (
                      <span key={i} className="px-2 py-0.5 bg-emphasis text-secondary text-xs rounded font-mono">
                        {c.field} {opLabel(c.operator)} {c.value}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                  <Button
                    onClick={() => {
                      setEditGroup(g)
                      setEditGroupName(g.name)
                      setEditGroupDescription(g.description ?? '')
                    }}
                  >
                    {t('common.edit')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => setSelectedGroup({ id: g.id, name: g.name })}
                  >
                    {t('dynamicGroups.run')}
                  </Button>
                  <button
                    onClick={() => deleteMutation.mutate(g.id)}
                    className="px-3 py-1.5 text-danger/60 hover:text-danger text-xs transition-colors"
                  >
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Execution result panel */}
      {selectedGroup && (
        <GroupResultPanel
          groupId={selectedGroup.id}
          groupName={selectedGroup.name}
          onClose={() => setSelectedGroup(null)}
        />
      )}

      {/* Edit Group Modal */}
      {editGroup && (
        <Modal title={t('dynamicGroups.editTitle')} onClose={() => setEditGroup(null)}>
          <form
            onSubmit={e => {
              e.preventDefault()
              const trimmed = editGroupName.trim()
              if (!trimmed) return
              updateMutation.mutate({
                id: editGroup.id,
                name: trimmed,
                description: editGroupDescription.trim() || undefined,
                conditions: editGroup.conditions ?? [],
              })
              setEditGroup(null)
            }}
            className="space-y-4"
          >
            <div>
              <Input label={`${t('common.name')} *`}
                autoFocus
                value={editGroupName}
                onChange={e => setEditGroupName(e.target.value)}
                className="w-full"
              />
            </div>
            <div>
              <Input
                label={t('common.description')}
                value={editGroupDescription}
                onChange={e => setEditGroupDescription(e.target.value)}
                className="w-full"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                type="button"
                onClick={() => setEditGroup(null)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                type="submit"
                disabled={updateMutation.isPending}
              >
                {updateMutation.isPending ? t('dynamicGroups.saving') : t('common.save')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
