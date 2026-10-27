import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'

interface ComplianceRule {
  field: string
  op: string
  value?: unknown
}

interface RuleForm {
  field: string
  op: string
  value: string
}

interface CompliancePolicy {
  id: string
  name: string
  description?: string
  ci_type_id?: string
  rules: ComplianceRule[]
  severity?: string
  is_active: boolean
  created_at: string
  target_type?: string
  target_group_id?: string | null
}

interface ComplianceResult {
  id: string
  ci_id: string
  ci_name: string
  policy_id: string
  policy_name: string
  status?: string
  details?: unknown
  checked_at: string
}

interface CheckSummary {
  status: 'compliant' | 'non_compliant'
  checked: number
  compliant: number
  non_compliant: number
  message?: string
}

const RULE_OPS: Array<{ value: string; needsValue: boolean }> = [
  { value: 'exists', needsValue: false },
  { value: 'not_exists', needsValue: false },
  { value: 'eq', needsValue: true },
  { value: 'ne', needsValue: true },
  { value: 'in', needsValue: true },
  { value: 'contains', needsValue: true },
  { value: 'gte', needsValue: true },
  { value: 'lte', needsValue: true },
]

const opNeedsValue = (op: string) => RULE_OPS.find(o => o.value === op)?.needsValue ?? false

const DEFAULT_RULE: RuleForm = { field: '', op: 'exists', value: '' }

function toRuleForms(rules: unknown): RuleForm[] {
  if (!Array.isArray(rules) || rules.length === 0) return [{ ...DEFAULT_RULE }]
  return rules.map(r => {
    const o = (r ?? {}) as Partial<ComplianceRule>
    const v = o.value
    const value = Array.isArray(v)
      ? v.map(String).join(', ')
      : v === undefined || v === null
        ? ''
        : String(v)
    return {
      field: typeof o.field === 'string' ? o.field : '',
      op: typeof o.op === 'string' && RULE_OPS.some(x => x.value === o.op) ? o.op : 'exists',
      value,
    }
  })
}

function apiErrorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: { message?: string } } } }
  return e?.response?.data?.error?.message ?? fallback
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-danger/10 text-danger',
  high: 'bg-warning/10 text-warning',
  medium: 'bg-warning/10 text-warning',
  low: 'bg-emphasis text-secondary',
  info: 'bg-info/10 text-info',
}

const STATUS_COLORS: Record<string, string> = {
  compliant: 'text-success',
  non_compliant: 'text-danger',
  unknown: 'text-muted',
}

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']

export default function Compliance() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formError, setFormError] = useState('')
  const [policyName, setPolicyName] = useState('')
  const [policyDesc, setPolicyDesc] = useState('')
  const [severity, setSeverity] = useState('medium')
  // T16: policy targeting — all | ci_type | dynamic_group.
  const [targetType, setTargetType] = useState<'all' | 'ci_type' | 'dynamic_group'>('all')
  const [targetTypeId, setTargetTypeId] = useState('')
  const [targetGroupId, setTargetGroupId] = useState('')
  const [rules, setRules] = useState<RuleForm[]>([{ ...DEFAULT_RULE }])
  const [activeTab, setActiveTab] = useState<'policies' | 'results'>('policies')
  const [checkResult, setCheckResult] = useState<CheckSummary | null>(null)

  const { data: policies = [], isLoading: loadingPolicies } = useQuery<CompliancePolicy[]>({
    queryKey: ['compliance-policies', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CompliancePolicy[] }>(
        `/orgs/${orgId}/compliance-policies`
      )
      return res.data ?? []
    },
  })

  const { data: ciTypes = [] } = useQuery<Array<{ id: string; display_name: string }>>({
    queryKey: ['ci-types', orgId],
    enabled: !!orgId && showForm,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: Array<{ id: string; display_name: string }> }>(`/orgs/${orgId}/ci-types`)
      return res.data ?? []
    },
  })

  const { data: dynGroups = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['ci-groups', orgId],
    enabled: !!orgId && showForm,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: Array<{ id: string; name: string }> }>(`/orgs/${orgId}/ci-groups`)
      return res.data ?? []
    },
  })

  const { data: results = [], isLoading: loadingResults } = useQuery<ComplianceResult[]>({
    queryKey: ['compliance-results', orgId],
    enabled: !!orgId && activeTab === 'results',
    queryFn: async () => {
      const { data: res } = await api.get<{ data: ComplianceResult[] }>(
        `/orgs/${orgId}/compliance/results`
      )
      return res.data ?? []
    },
  })

  const closeForm = () => {
    setShowForm(false)
    setEditingId(null)
    setFormError('')
  }

  const openCreate = () => {
    setEditingId(null)
    setPolicyName('')
    setPolicyDesc('')
    setSeverity('medium')
    setTargetType('all')
    setTargetTypeId('')
    setTargetGroupId('')
    setRules([{ ...DEFAULT_RULE }])
    setFormError('')
    setShowForm(true)
  }

  const openEdit = (p: CompliancePolicy) => {
    setEditingId(p.id)
    setPolicyName(p.name)
    setPolicyDesc(p.description ?? '')
    setSeverity(p.severity ?? 'medium')
    const tt = (p.target_type ?? (p.ci_type_id ? 'ci_type' : 'all')) as 'all' | 'ci_type' | 'dynamic_group'
    setTargetType(tt)
    setTargetTypeId(p.ci_type_id ?? '')
    setTargetGroupId(p.target_group_id ?? '')
    setRules(toRuleForms(p.rules))
    setFormError('')
    setShowForm(true)
  }

  const buildPayload = (): Record<string, unknown> | null => {
    if (rules.length === 0) {
      setFormError(t('compliance.atLeastOneRule'))
      return null
    }
    const serialized: Array<Record<string, unknown>> = []
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i]
      const field = r.field.trim()
      if (!field) {
        setFormError(`${t('compliance.ruleFieldRequired')} (#${i + 1})`)
        return null
      }
      const rule: Record<string, unknown> = { field, op: r.op }
      if (opNeedsValue(r.op)) {
        const trimmed = r.value.trim()
        if (!trimmed) {
          setFormError(`${t('compliance.ruleValueRequired')} (#${i + 1})`)
          return null
        }
        rule.value =
          r.op === 'in'
            ? trimmed.split(',').map(v => v.trim()).filter(Boolean)
            : r.op === 'gte' || r.op === 'lte'
              ? Number.isNaN(Number(trimmed)) ? trimmed : Number(trimmed)
              : trimmed
      }
      serialized.push(rule)
    }
    const target: Record<string, unknown> = {}
    if (targetType === 'ci_type' && targetTypeId) {
      target.ci_type_id = targetTypeId
      target.target_type = 'ci_type'
    } else if (targetType === 'dynamic_group' && targetGroupId) {
      target.target_type = 'dynamic_group'
      target.target_group_id = targetGroupId
    }
    return {
      name: policyName.trim(),
      description: policyDesc.trim() || undefined,
      severity,
      rules: serialized,
      ...target,
    }
  }

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.post(`/orgs/${orgId}/compliance-policies`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['compliance-policies', orgId] })
      closeForm()
    },
    onError: err => setFormError(apiErrorMessage(err, t('compliance.createFailed'))),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
      api.put(`/orgs/${orgId}/compliance-policies/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['compliance-policies', orgId] })
      closeForm()
    },
    onError: err => setFormError(apiErrorMessage(err, t('compliance.updateFailed'))),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/compliance-policies/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['compliance-policies', orgId] }),
  })

  const toggleMutation = useMutation({
    mutationFn: (p: CompliancePolicy) =>
      api.put(`/orgs/${orgId}/compliance-policies/${p.id}`, { is_active: !p.is_active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['compliance-policies', orgId] }),
  })

  const runCheckMutation = useMutation({
    mutationFn: () => api.post<{ data: CheckSummary }>(`/orgs/${orgId}/compliance/run`, {}),
    onSuccess: res => {
      setCheckResult(res.data.data)
      queryClient.invalidateQueries({ queryKey: ['compliance-results', orgId] })
      setActiveTab('results')
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!policyName.trim()) { setFormError(t('compliance.nameRequired')); return }
    const payload = buildPayload()
    if (!payload) return
    if (editingId) {
      updateMutation.mutate({ id: editingId, payload })
    } else {
      createMutation.mutate(payload)
    }
  }

  const updateRule = (i: number, patch: Partial<RuleForm>) => {
    setRules(rs => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  const violationText = (v: unknown): string => {
    const o = (v ?? {}) as ComplianceRule
    const field = typeof o.field === 'string' ? o.field : '?'
    const opLabel = t(`compliance.op.${o.op}`, { defaultValue: o.op ?? '' })
    const val = Array.isArray(o.value)
      ? o.value.map(String).join(', ')
      : o.value === undefined || o.value === null
        ? ''
        : String(o.value)
    return val ? `${field} ${opLabel} ${val}` : `${field} ${opLabel}`
  }

  const inputCls =
    'w-full bg-emphasis text-primary text-sm rounded px-3 py-2 border border-strong focus:outline-none focus:border-accent'

  // T12: latest compliance run (manual or scheduled).
  const { data: lastRun } = useQuery<{ status?: string; started_at?: string; result?: { trigger?: string } } | null>({
    queryKey: ['compliance-last-run', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: null | { status?: string; started_at?: string; result?: { trigger?: string } } }>(
        `/orgs/${orgId}/compliance/last-run`
      )
      return res.data ?? null
    },
  })

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="page-title">{t('compliance.title')}</h1>
          <p className="text-sm text-secondary mt-1">{t('compliance.subtitle')}</p>
          {lastRun?.started_at && (
            <p className="text-xs text-muted mt-1 flex items-center gap-2" data-testid="compliance-last-run">
              <span className="px-1.5 py-0.5 bg-violet/10 text-violet rounded text-xs">
                {t('compliance.scheduledBadge')}
              </span>
              {t('compliance.lastRun', {
                time: new Date(lastRun.started_at).toLocaleString(),
                trigger: t(`compliance.trigger.${lastRun.result?.trigger ?? 'manual'}`, { defaultValue: lastRun.result?.trigger ?? 'manual' }),
              })}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => runCheckMutation.mutate()}
            disabled={runCheckMutation.isPending}
            className="px-4 py-2 bg-success-solid hover:bg-success-solid/90 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
          >
            {runCheckMutation.isPending ? t('compliance.checking') : t('compliance.runCheck')}
          </button>
          <button
            onClick={showForm ? closeForm : openCreate}
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm rounded-lg transition-colors"
          >
            {showForm ? t('common.cancel') : t('compliance.newPolicy')}
          </button>
        </div>
      </div>

      {/* Check result banner */}
      {checkResult && (
        <div className={`rounded-xl p-4 mb-5 flex items-center gap-4 ${
          checkResult.status === 'compliant'
            ? 'bg-success/10 border border-success/25'
            : 'bg-danger/10 border border-danger/25'
        }`}>
          <span className="text-2xl">{checkResult.status === 'compliant' ? '✅' : '⚠️'}</span>
          <div>
            <p className="text-primary font-medium">
              {t(`status.${checkResult.status}`)}
            </p>
            <p className="text-sm text-secondary">
              {checkResult.message ?? t('compliance.checkSummary', { checked: checkResult.checked, compliant: checkResult.compliant, nonCompliant: checkResult.non_compliant })}
            </p>
          </div>
          <button onClick={() => setCheckResult(null)} className="ml-auto text-muted hover:text-secondary text-sm">
            {t('compliance.dismiss')}
          </button>
        </div>
      )}

      {/* Create / edit policy form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-subtle rounded-xl p-5 mb-6 space-y-4">
          <h2 className="text-sm font-semibold text-primary">
            {editingId ? t('compliance.editPolicyTitle') : t('compliance.createPolicyTitle')}
          </h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-secondary mb-1">{t('compliance.nameField')}</label>
              <input
                type="text"
                value={policyName}
                onChange={e => setPolicyName(e.target.value)}
                className={inputCls}
                placeholder="required-tags"
              />
            </div>
            <div>
              <label className="block text-xs text-secondary mb-1">{t('compliance.severity')}</label>
              <select
                value={severity}
                onChange={e => setSeverity(e.target.value)}
                className={inputCls}
              >
                {SEVERITIES.map(s => <option key={s} value={s}>{t(`status.${s}`, { defaultValue: s.charAt(0).toUpperCase() + s.slice(1) })}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-secondary mb-1">{t('common.description')}</label>
            <input
              type="text"
              value={policyDesc}
              onChange={e => setPolicyDesc(e.target.value)}
              className={inputCls}
              placeholder={t('compliance.policyDescPlaceholder')}
            />
          </div>

          {/* Target scope (T16) */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-secondary mb-1">{t('compliance.targetScope')}</label>
              <select
                value={targetType}
                onChange={(e) => setTargetType(e.target.value as 'all' | 'ci_type' | 'dynamic_group')}
                className={inputCls}
                data-testid="compliance-target-type"
              >
                <option value="all">{t('compliance.targetAll')}</option>
                <option value="ci_type">{t('compliance.targetTypeOption')}</option>
                <option value="dynamic_group">{t('compliance.targetGroup')}</option>
              </select>
            </div>
            {targetType === 'ci_type' && (
              <div>
                <label className="block text-xs text-secondary mb-1">{t('compliance.targetTypeOption')}</label>
                <select value={targetTypeId} onChange={(e) => setTargetTypeId(e.target.value)} className={inputCls}>
                  <option value="">{t('compliance.selectType')}</option>
                  {ciTypes.map((ct) => (
                    <option key={ct.id} value={ct.id}>{ct.display_name}</option>
                  ))}
                </select>
              </div>
            )}
            {targetType === 'dynamic_group' && (
              <div>
                <label className="block text-xs text-secondary mb-1">{t('compliance.targetGroup')}</label>
                <select value={targetGroupId} onChange={(e) => setTargetGroupId(e.target.value)} className={inputCls}>
                  <option value="">{t('compliance.selectGroup')}</option>
                  {dynGroups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Rules editor */}
          <div>
            <div className="flex items-baseline justify-between mb-2">
              <label className="block text-xs text-secondary">{t('compliance.rules')} *</label>
              <span className="text-xs text-muted">{t('compliance.rulesHint')}</span>
            </div>
            <div className="space-y-2">
              {rules.map((r, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center">
                  <input
                    type="text"
                    aria-label={t('compliance.ruleFieldAria', { index: i + 1 })}
                    value={r.field}
                    onChange={e => updateRule(i, { field: e.target.value })}
                    className={`${inputCls} col-span-4`}
                    placeholder={t('compliance.ruleFieldPlaceholder')}
                  />
                  <select
                    aria-label={t('compliance.ruleOpAria', { index: i + 1 })}
                    value={r.op}
                    onChange={e => updateRule(i, { op: e.target.value })}
                    className={`${inputCls} col-span-3`}
                  >
                    {RULE_OPS.map(o => (
                      <option key={o.value} value={o.value}>
                        {t(`compliance.op.${o.value}`, { defaultValue: o.value })}
                      </option>
                    ))}
                  </select>
                  {opNeedsValue(r.op) ? (
                    <input
                      type="text"
                      aria-label={t('compliance.ruleValueAria', { index: i + 1 })}
                      value={r.value}
                      onChange={e => updateRule(i, { value: e.target.value })}
                      className={`${inputCls} col-span-4`}
                      placeholder={r.op === 'in' ? t('compliance.ruleValueInHint') : t('compliance.ruleValue')}
                    />
                  ) : (
                    <div className="col-span-4" />
                  )}
                  <button
                    type="button"
                    onClick={() => setRules(rs => rs.filter((_, idx) => idx !== i))}
                    disabled={rules.length === 1}
                    aria-label={t('compliance.removeRuleAria', { index: i + 1 })}
                    className="col-span-1 text-danger/60 hover:text-danger disabled:opacity-30 text-sm transition-colors"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setRules(rs => [...rs, { ...DEFAULT_RULE }])}
              className="mt-2 text-xs text-accent hover:text-accent"
            >
              {t('compliance.addRule')}
            </button>
          </div>

          {formError && <p className="text-sm text-danger">{formError}</p>}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={closeForm} className="px-4 py-2 text-sm text-secondary hover:text-primary">{t('common.cancel')}</button>
            <button
              type="submit"
              disabled={createMutation.isPending || updateMutation.isPending}
              className="px-4 py-2 bg-accent hover:bg-accent-hover disabled:opacity-50 text-on-accent text-sm rounded-lg"
            >
              {editingId
                ? (updateMutation.isPending ? t('compliance.saving') : t('compliance.save'))
                : (createMutation.isPending ? t('compliance.creating') : t('compliance.createPolicy'))}
            </button>
          </div>
        </form>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-5 bg-subtle/50 rounded-lg p-1 w-fit">
        {(['policies', 'results'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-1.5 rounded text-sm transition-colors ${
              activeTab === tab ? 'bg-emphasis text-primary' : 'text-secondary hover:text-primary'
            }`}
          >
            {tab === 'policies' ? t('compliance.tabPolicies') : t('compliance.tabResults')}
          </button>
        ))}
      </div>

      {/* Policies tab */}
      {activeTab === 'policies' && (
        loadingPolicies ? (
          <div className="text-center py-20 text-muted">{t('compliance.loadingPolicies')}</div>
        ) : policies.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-4xl mb-3">📋</p>
            <p className="text-secondary text-lg font-medium">{t('compliance.noPolicies')}</p>
            <p className="text-muted text-sm mt-1">{t('compliance.noPoliciesHint')}</p>
          </div>
        ) : (
          <div className="bg-subtle rounded-xl overflow-hidden">
            <div className="table-scroll" tabIndex={0}><table className="w-full">
              <thead>
                <tr className="text-secondary text-xs font-medium uppercase tracking-wider border-b border-strong">
                  <th className="px-4 py-3 text-left">{t('compliance.policy')}</th>
                  <th className="px-4 py-3 text-left">{t('compliance.rules')}</th>
                  <th className="px-4 py-3 text-left">{t('compliance.severity')}</th>
                  <th className="px-4 py-3 text-left">{t('common.status')}</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {policies.map(p => (
                  <tr key={p.id} className="border-b border-strong/50 last:border-0">
                    <td className="px-4 py-3">
                      <p className="text-primary font-medium">{p.name}</p>
                      {p.description && <p className="text-muted text-xs mt-0.5">{p.description}</p>}
                    </td>
                    <td className="px-4 py-3">
                      {Array.isArray(p.rules) && p.rules.length > 0 ? (
                        <span className="text-secondary text-sm">
                          {t('compliance.rulesCount', { count: p.rules.length })}
                        </span>
                      ) : (
                        <span className="text-muted text-sm">{t('compliance.noRules')}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {p.severity ? (
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${SEVERITY_COLORS[p.severity] ?? 'bg-emphasis text-secondary'}`}>
                          {t(`status.${p.severity}`, { defaultValue: p.severity })}
                        </span>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-sm ${p.is_active ? 'text-success' : 'text-muted'}`}>
                        {p.is_active ? t('common.active') : t('common.inactive')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        onClick={() => openEdit(p)}
                        className="text-accent/80 hover:text-accent text-xs mr-3 transition-colors"
                      >
                        {t('common.edit')}
                      </button>
                      <button
                        onClick={() => toggleMutation.mutate(p)}
                        className="text-secondary hover:text-primary text-xs mr-3 transition-colors"
                      >
                        {p.is_active ? t('compliance.deactivate') : t('compliance.activate')}
                      </button>
                      <button
                        onClick={() => deleteMutation.mutate(p.id)}
                        className="text-danger/60 hover:text-danger text-xs transition-colors"
                      >
                        {t('common.delete')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )
      )}

      {/* Results tab */}
      {activeTab === 'results' && (
        loadingResults ? (
          <div className="text-center py-20 text-muted">{t('compliance.loadingResults')}</div>
        ) : results.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-4xl mb-3">🔍</p>
            <p className="text-secondary text-lg font-medium">{t('compliance.noResults')}</p>
            <p className="text-muted text-sm mt-1">{t('compliance.noResultsHint')}</p>
          </div>
        ) : (
          <div className="bg-subtle rounded-xl overflow-hidden">
            <div className="table-scroll" tabIndex={0}><table className="w-full">
              <thead>
                <tr className="text-secondary text-xs font-medium uppercase tracking-wider border-b border-strong">
                  <th className="px-4 py-3 text-left">{t('compliance.ci')}</th>
                  <th className="px-4 py-3 text-left">{t('compliance.policy')}</th>
                  <th className="px-4 py-3 text-left">{t('common.status')}</th>
                  <th className="px-4 py-3 text-left">{t('compliance.violations')}</th>
                  <th className="px-4 py-3 text-left">{t('compliance.checked')}</th>
                </tr>
              </thead>
              <tbody>
                {results.map(r => (
                  <tr key={r.id} className="border-b border-strong/50 last:border-0 align-top">
                    <td className="px-4 py-3 text-primary font-medium">{r.ci_name}</td>
                    <td className="px-4 py-3 text-secondary text-sm">{r.policy_name}</td>
                    <td className="px-4 py-3">
                      <span className={`text-sm font-medium ${STATUS_COLORS[r.status ?? 'unknown'] ?? 'text-secondary'}`}>
                        {t(`status.${r.status ?? 'unknown'}`, { defaultValue: r.status ?? 'unknown' })}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {r.status === 'non_compliant' && Array.isArray(r.details) && r.details.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {r.details.map((v, i) => (
                            <span
                              key={i}
                              className="px-2 py-0.5 rounded-full bg-danger/10 border border-danger/25 text-danger text-xs"
                            >
                              {violationText(v)}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-muted text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted text-xs">
                      {new Date(r.checked_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )
      )}
    </div>
  )
}
