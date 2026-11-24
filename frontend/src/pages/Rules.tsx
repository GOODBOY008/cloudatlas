import { Table } from '@cloudflare/kumo/components/table'
import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { NativeDialog } from '../components/shared/NativeDialog'
import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import type { Rule, RuleCondition, Pool } from '../types'

const CONDITION_TYPES = [
  'tag_is',
  'name_is',
  'region_is',
  'cloud_is',
  'resource_type_is',
]

interface RuleForm {
  name: string
  priority: string
  pool_id: string
  logic_operator: 'AND' | 'OR'
  is_active: boolean
  conditions: RuleCondition[]
}

type RulePayload = Omit<RuleForm, 'priority'> & { priority: number }

const DEFAULT_FORM: RuleForm = {
  name: '',
  priority: '10',
  pool_id: '',
  logic_operator: 'AND',
  is_active: true,
  conditions: [{ condition_type: 'tag_is', key: '', value: '' }],
}

function ConditionRow({
  cond,
  idx,
  onChange,
  onRemove,
}: {
  cond: RuleCondition
  idx: number
  onChange: (idx: number, c: RuleCondition) => void
  onRemove: (idx: number) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <SelectField
        aria-label={t('common.type')}
        value={cond.condition_type}
        onValueChange={value => onChange(idx, { ...cond, condition_type: value })}
        items={CONDITION_TYPES.map((v) => ({ value: v, label: t(`rules.conditionTypes.${v}`) }))}
      />
      {cond.condition_type === 'tag_is' && (
        <Input
          aria-label={t('rules.tagKeyPlaceholder')}
          placeholder={t('rules.tagKeyPlaceholder')}
          value={cond.key ?? ''}
          onChange={(e) => onChange(idx, { ...cond, key: e.target.value })}
          className="w-28"
        />
      )}
      <Input
        aria-label={t('rules.valuePlaceholder')}
        placeholder={t('rules.valuePlaceholder')}
        value={cond.value}
        onChange={(e) => onChange(idx, { ...cond, value: e.target.value })}
        className="w-32"
      />
      <button
        type="button"
        onClick={() => onRemove(idx)}
        className="text-danger hover:text-danger text-lg leading-none"
        title={t('rules.remove')}
      >
        ×
      </button>
    </div>
  )
}

export default function Rules() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<RuleForm>(DEFAULT_FORM)
  const [formError, setFormError] = useState('')

  const { data: rules = [], isLoading, isError } = useQuery<Rule[]>({
    queryKey: ['assignment-rules', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: Rule[] }>(`/orgs/${orgId}/assignment-rules`)
      return res.data ?? []
    },
  })

  const { data: pools = [] } = useQuery<Pool[]>({
    queryKey: ['pools', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: Pool[] }>(`/orgs/${orgId}/pools`)
      return res.data ?? []
    },
  })

  const createMutation = useMutation({
    mutationFn: (payload: RulePayload) =>
      api.post(`/orgs/${orgId}/assignment-rules`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assignment-rules', orgId] })
      closeModal()
    },
    onError: () => setFormError(t('rules.createFailed')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: RulePayload }) =>
      api.put(`/orgs/${orgId}/assignment-rules/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assignment-rules', orgId] })
      closeModal()
    },
    onError: () => setFormError(t('rules.updateFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/assignment-rules/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['assignment-rules', orgId] }),
  })

  const applyMutation = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/assignment-rules/apply`, {}),
  })

  function openCreate() {
    setEditingId(null)
    setForm(DEFAULT_FORM)
    setFormError('')
    setShowModal(true)
  }

  function openEdit(rule: Rule) {
    setEditingId(rule.id)
    setForm({
      name: rule.name,
      priority: String(rule.priority),
      pool_id: rule.pool_id,
      logic_operator: rule.logic_operator,
      is_active: rule.is_active,
      conditions: rule.conditions.length
        ? rule.conditions
        : [{ condition_type: 'tag_is', key: '', value: '' }],
    })
    setFormError('')
    setShowModal(true)
  }

  function closeModal() {
    setShowModal(false)
    setEditingId(null)
    setFormError('')
  }

  function handleConditionChange(idx: number, cond: RuleCondition) {
    const next = [...form.conditions]
    next[idx] = cond
    setForm({ ...form, conditions: next })
  }

  function removeCondition(idx: number) {
    setForm({ ...form, conditions: form.conditions.filter((_, i) => i !== idx) })
  }

  function addCondition() {
    setForm({
      ...form,
      conditions: [...form.conditions, { condition_type: 'tag_is', key: '', value: '' }],
    })
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError('')
    const payload = { ...form, priority: Number(form.priority || DEFAULT_FORM.priority) }
    if (editingId) {
      updateMutation.mutate({ id: editingId, payload })
    } else {
      createMutation.mutate(payload)
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('rules.title')}</h1>
        <div className="flex gap-3">
          <Button
            onClick={() => applyMutation.mutate()}
            disabled={applyMutation.isPending}
          >
            {applyMutation.isPending ? t('rules.applying') : t('rules.applyRules')}
          </Button>
          <Button
            variant="primary"
            onClick={openCreate}
          >
            {t('rules.newRule')}
          </Button>
        </div>
      </div>

      {applyMutation.isSuccess && (
        <div className="mb-4 p-3 rounded-lg bg-success/10 border border-success/25 text-success text-sm">
          {t('rules.appliedSuccess')}
        </div>
      )}

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
          {t('rules.loadFailed')}
        </div>
      )}

      <div className="bg-surface border border-edge rounded-xl overflow-hidden">
        <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
          <Table.Header variant="compact">
            <Table.Row className="border-b border-edge text-secondary text-left">
              <Table.Head className="px-4 py-3 font-medium">{t('common.name')}</Table.Head>
              <Table.Head className="px-4 py-3 font-medium">{t('rules.colPriority')}</Table.Head>
              <Table.Head className="px-4 py-3 font-medium">{t('rules.colConditions')}</Table.Head>
              <Table.Head className="px-4 py-3 font-medium">{t('rules.colPool')}</Table.Head>
              <Table.Head className="px-4 py-3 font-medium">{t('rules.colLogic')}</Table.Head>
              <Table.Head className="px-4 py-3 font-medium">{t('common.status')}</Table.Head>
              <Table.Head className="px-4 py-3 font-medium">{t('common.actions')}</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {isLoading ? (
              <Table.Row>
                <Table.Cell colSpan={7} className="px-4 py-8 text-center text-muted">
                  {t('common.loading')}
                </Table.Cell>
              </Table.Row>
            ) : rules.length === 0 ? (
              <Table.Row>
                <Table.Cell colSpan={7} className="px-4 py-8 text-center text-muted">
                  {t('rules.noRules')}
                </Table.Cell>
              </Table.Row>
            ) : (
              rules.map((rule) => (
                <Table.Row
                  key={rule.id}
                  className="border-b border-edge hover:bg-subtle/50 transition-colors"
                >
                  <Table.Cell className="px-4 py-3 font-medium text-primary">{rule.name}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary">{rule.priority}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary text-xs max-w-xs">
                    {rule.conditions.map((c, i) => (
                      <span key={i} className="inline-block bg-subtle border border-strong rounded px-1.5 py-0.5 mr-1 mb-1">
                        {c.condition_type === 'tag_is' && c.key
                          ? `tag:${c.key}=${c.value}`
                          : `${c.condition_type}:${c.value}`}
                      </span>
                    ))}
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary">
                    {rule.pool_name ?? pools.find((p) => p.id === rule.pool_id)?.name ?? rule.pool_id.slice(0, 8)}
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3">
                    <span className="text-xs text-secondary uppercase">{rule.logic_operator}</span>
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3">
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        rule.is_active ? 'bg-success/10 text-success' : 'bg-emphasis text-secondary'
                      }`}
                    >
                      {rule.is_active ? t('common.active') : t('common.inactive')}
                    </span>
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Button
                        size="sm" variant="ghost"
                        onClick={() => openEdit(rule)}
                      >
                        {t('common.edit')}
                      </Button>
                      <Button
                        size="sm" variant="secondary-destructive"
                        onClick={() => deleteMutation.mutate(rule.id)}
                        disabled={deleteMutation.isPending}
                      >
                        {t('common.delete')}
                      </Button>
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))
            )}
          </Table.Body>
        </Table></div>
      </div>

      {/* Modal */}
      {showModal && (
        <NativeDialog className="items-center justify-center p-4" label={editingId ? t('rules.editTitle') : t('rules.newTitle')} onClose={closeModal}>
          <div className="dialog-panel p-6 w-full max-w-lg">
            <h3 className="text-base font-semibold text-primary mb-4">
              {editingId ? t('rules.editTitle') : t('rules.newTitle')}
            </h3>
            {formError && (
              <div className="mb-3 p-2 rounded bg-danger/10 border border-danger/25 text-danger text-sm">
                {formError}
              </div>
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Input label={t('common.name')}
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full"
                  placeholder={t('rules.namePlaceholder')}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Input
                    label={t('rules.priorityLabel')}
                    type="number"
                    min={1}
                    max={100}
                    value={form.priority}
                    onChange={e => setForm({ ...form, priority: e.target.value })}
                    className="w-full"
                  />
                </div>
                <div>
                  <SelectField
                    label={t('rules.logicOperator')}
                    value={form.logic_operator}
                    onValueChange={value =>
                      setForm({ ...form, logic_operator: value as 'AND' | 'OR' })}
                    className="w-full"
                    items={[
                      { value: "AND", label: t('rules.andOption') },
                      { value: "OR", label: t('rules.orOption') },
                    ]}
                  />
                </div>
              </div>
              <div>
                <SelectField
                  label={t('rules.assignToPool')}
                  required
                  value={form.pool_id}
                  onValueChange={value => setForm({ ...form, pool_id: value })}
                  className="w-full"
                  items={[
                    { value: "", label: t('rules.selectPool') },
                    ...pools.map((p) => ({ value: p.id, label: p.name })),
                  ]}
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-secondary">{t('rules.conditions')}</label>
                  <button
                    type="button"
                    onClick={addCondition}
                    className="text-xs text-accent hover:text-accent"
                  >
                    {t('rules.addCondition')}
                  </button>
                </div>
                <div className="space-y-2">
                  {form.conditions.map((cond, idx) => (
                    <ConditionRow
                      key={idx}
                      cond={cond}
                      idx={idx}
                      onChange={handleConditionChange}
                      onRemove={removeCondition}
                    />
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is-active"
                  checked={form.is_active}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                  className="w-4 h-4 rounded border-strong"
                />
                <label htmlFor="is-active" className="text-sm text-secondary">
                  {t('common.active')}
                </label>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button
                  type="button"
                  onClick={closeModal}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={createMutation.isPending || updateMutation.isPending}
                >
                  {createMutation.isPending || updateMutation.isPending
                    ? t('rules.saving')
                    : editingId
                    ? t('rules.updateRule')
                    : t('rules.createRule')}
                </Button>
              </div>
            </form>
          </div>
        </NativeDialog>
      )}
    </div>
  )
}
