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
  priority: number
  pool_id: string
  logic_operator: 'AND' | 'OR'
  is_active: boolean
  conditions: RuleCondition[]
}

const DEFAULT_FORM: RuleForm = {
  name: '',
  priority: 10,
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
  const inputCls =
    'bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500'
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        value={cond.condition_type}
        onChange={(e) => onChange(idx, { ...cond, condition_type: e.target.value })}
        className={inputCls}
      >
        {CONDITION_TYPES.map((v) => (
          <option key={v} value={v}>
            {t(`rules.conditionTypes.${v}`)}
          </option>
        ))}
      </select>
      {cond.condition_type === 'tag_is' && (
        <input
          placeholder={t('rules.tagKeyPlaceholder')}
          value={cond.key ?? ''}
          onChange={(e) => onChange(idx, { ...cond, key: e.target.value })}
          className={`${inputCls} w-28`}
        />
      )}
      <input
        placeholder={t('rules.valuePlaceholder')}
        value={cond.value}
        onChange={(e) => onChange(idx, { ...cond, value: e.target.value })}
        className={`${inputCls} w-32`}
      />
      <button
        type="button"
        onClick={() => onRemove(idx)}
        className="text-red-400 hover:text-red-300 text-lg leading-none"
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
    mutationFn: (payload: RuleForm) =>
      api.post(`/orgs/${orgId}/assignment-rules`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assignment-rules', orgId] })
      closeModal()
    },
    onError: () => setFormError(t('rules.createFailed')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: RuleForm }) =>
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
      priority: rule.priority,
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
    if (editingId) {
      updateMutation.mutate({ id: editingId, payload: form })
    } else {
      createMutation.mutate(form)
    }
  }

  const inputCls =
    'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-500'

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">{t('rules.title')}</h2>
        <div className="flex gap-3">
          <button
            onClick={() => applyMutation.mutate()}
            disabled={applyMutation.isPending}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {applyMutation.isPending ? t('rules.applying') : t('rules.applyRules')}
          </button>
          <button
            onClick={openCreate}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {t('rules.newRule')}
          </button>
        </div>
      </div>

      {applyMutation.isSuccess && (
        <div className="mb-4 p-3 rounded-lg bg-green-900/40 border border-green-700 text-green-300 text-sm">
          {t('rules.appliedSuccess')}
        </div>
      )}

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
          {t('rules.loadFailed')}
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-400 text-left">
              <th className="px-4 py-3 font-medium">{t('common.name')}</th>
              <th className="px-4 py-3 font-medium">{t('rules.colPriority')}</th>
              <th className="px-4 py-3 font-medium">{t('rules.colConditions')}</th>
              <th className="px-4 py-3 font-medium">{t('rules.colPool')}</th>
              <th className="px-4 py-3 font-medium">{t('rules.colLogic')}</th>
              <th className="px-4 py-3 font-medium">{t('common.status')}</th>
              <th className="px-4 py-3 font-medium">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                  {t('common.loading')}
                </td>
              </tr>
            ) : rules.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                  {t('rules.noRules')}
                </td>
              </tr>
            ) : (
              rules.map((rule) => (
                <tr
                  key={rule.id}
                  className="border-b border-gray-800 hover:bg-gray-800/50 transition-colors"
                >
                  <td className="px-4 py-3 font-medium text-white">{rule.name}</td>
                  <td className="px-4 py-3 text-gray-300">{rule.priority}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs max-w-xs">
                    {rule.conditions.map((c, i) => (
                      <span key={i} className="inline-block bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 mr-1 mb-1">
                        {c.condition_type === 'tag_is' && c.key
                          ? `tag:${c.key}=${c.value}`
                          : `${c.condition_type}:${c.value}`}
                      </span>
                    ))}
                  </td>
                  <td className="px-4 py-3 text-gray-300">
                    {rule.pool_name ?? pools.find((p) => p.id === rule.pool_id)?.name ?? rule.pool_id.slice(0, 8)}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-gray-400 uppercase">{rule.logic_operator}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        rule.is_active ? 'bg-green-900/40 text-green-300' : 'bg-gray-700 text-gray-400'
                      }`}
                    >
                      {rule.is_active ? t('common.active') : t('common.inactive')}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => openEdit(rule)}
                        className="text-indigo-400 hover:text-indigo-300 text-xs"
                      >
                        {t('common.edit')}
                      </button>
                      <button
                        onClick={() => deleteMutation.mutate(rule.id)}
                        disabled={deleteMutation.isPending}
                        className="text-red-400 hover:text-red-300 text-xs disabled:opacity-50"
                      >
                        {t('common.delete')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-900 rounded-xl p-6 w-full max-w-lg border border-gray-800 shadow-xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-base font-semibold text-white mb-4">
              {editingId ? t('rules.editTitle') : t('rules.newTitle')}
            </h3>
            {formError && (
              <div className="mb-3 p-2 rounded bg-red-900/40 border border-red-700 text-red-300 text-sm">
                {formError}
              </div>
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('common.name')}</label>
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className={inputCls}
                  placeholder={t('rules.namePlaceholder')}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">{t('rules.priorityLabel')}</label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={form.priority}
                    onChange={(e) => setForm({ ...form, priority: parseInt(e.target.value) || 10 })}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">{t('rules.logicOperator')}</label>
                  <select
                    value={form.logic_operator}
                    onChange={(e) =>
                      setForm({ ...form, logic_operator: e.target.value as 'AND' | 'OR' })
                    }
                    className={inputCls}
                  >
                    <option value="AND">{t('rules.andOption')}</option>
                    <option value="OR">{t('rules.orOption')}</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('rules.assignToPool')}</label>
                <select
                  required
                  value={form.pool_id}
                  onChange={(e) => setForm({ ...form, pool_id: e.target.value })}
                  className={inputCls}
                >
                  <option value="">{t('rules.selectPool')}</option>
                  {pools.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-gray-400">{t('rules.conditions')}</label>
                  <button
                    type="button"
                    onClick={addCondition}
                    className="text-xs text-indigo-400 hover:text-indigo-300"
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
                  className="w-4 h-4 rounded border-gray-700 accent-indigo-600"
                />
                <label htmlFor="is-active" className="text-sm text-gray-300">
                  {t('common.active')}
                </label>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending || updateMutation.isPending}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  {createMutation.isPending || updateMutation.isPending
                    ? t('rules.saving')
                    : editingId
                    ? t('rules.updateRule')
                    : t('rules.createRule')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
