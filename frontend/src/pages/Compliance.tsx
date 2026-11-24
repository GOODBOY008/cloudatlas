import { Table } from '@cloudflare/kumo/components/table'
import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
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
    <div className="space-y-6">
      {/* Header */}
      <div className="page-header">
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
          <Button
            variant="primary"
            onClick={() => runCheckMutation.mutate()}
            disabled={runCheckMutation.isPending}
          >
            {runCheckMutation.isPending ? t('compliance.checking') : t('compliance.runCheck')}
          </Button>
          <Button
            variant={showForm ? 'secondary' : 'primary'}
            onClick={showForm ? closeForm : openCreate}
          >
            {showForm ? t('common.cancel') : t('compliance.newPolicy')}
          </Button>
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
              <Input
                label={t('compliance.nameField')}
                type="text"
                value={policyName}
                onChange={e => setPolicyName(e.target.value)}
                className="w-full"
                placeholder="required-tags"
              />
            </div>
            <div>
              <SelectField
                label={t('compliance.severity')}
                value={severity}
                onValueChange={setSeverity}
                className="w-full"
                items={SEVERITIES.map(s => ({ value: s, label: t(`status.${s}`, { defaultValue: s.charAt(0).toUpperCase() + s.slice(1) }) }))}
              />
            </div>
          </div>
          <div>
            <Input
              label={t('common.description')}
              type="text"
              value={policyDesc}
              onChange={e => setPolicyDesc(e.target.value)}
              className="w-full"
              placeholder={t('compliance.policyDescPlaceholder')}
            />
          </div>

          {/* Target scope (T16) */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <SelectField
                label={t('compliance.targetScope')}
                value={targetType}
                onValueChange={value => setTargetType(value as 'all' | 'ci_type' | 'dynamic_group')}
                className="w-full"
                data-testid="compliance-target-type"
                items={[
                  { value: "all", label: t('compliance.targetAll') },
                  { value: "ci_type", label: t('compliance.targetTypeOption') },
                  { value: "dynamic_group", label: t('compliance.targetGroup') },
                ]}
              />
            </div>
            {targetType === 'ci_type' && (
              <div>
                <SelectField
                  label={t('compliance.targetTypeOption')}
                  value={targetTypeId}
                  onValueChange={setTargetTypeId}
                  className="w-full"
                  items={[
                    { value: "", label: t('compliance.selectType') },
                    ...ciTypes.map((ct) => ({ value: ct.id, label: ct.display_name })),
                  ]}
                />
              </div>
            )}
            {targetType === 'dynamic_group' && (
              <div>
                <SelectField
                  label={t('compliance.targetGroup')}
                  value={targetGroupId}
                  onValueChange={setTargetGroupId}
                  className="w-full"
                  items={[
                    { value: "", label: t('compliance.selectGroup') },
                    ...dynGroups.map((g) => ({ value: g.id, label: g.name })),
                  ]}
                />
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
                  <Input
                    type="text"
                    aria-label={t('compliance.ruleFieldAria', { index: i + 1 })}
                    value={r.field}
                    onChange={e => updateRule(i, { field: e.target.value })}
                    className="w-full col-span-4"
                    placeholder={t('compliance.ruleFieldPlaceholder')}
                  />
                  <SelectField
                    aria-label={t('compliance.ruleOpAria', { index: i + 1 })}
                    value={r.op}
                    onValueChange={value => updateRule(i, { op: value })}
                    className="w-full col-span-3"
                    items={RULE_OPS.map(o => ({ value: o.value, label: t(`compliance.op.${o.value}`, { defaultValue: o.value }) }))}
                  />
                  {opNeedsValue(r.op) ? (
                    <Input
                      type="text"
                      aria-label={t('compliance.ruleValueAria', { index: i + 1 })}
                      value={r.value}
                      onChange={e => updateRule(i, { value: e.target.value })}
                      className="w-full col-span-4"
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
            <Button variant="ghost" type="button" onClick={closeForm}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              type="submit"
              disabled={createMutation.isPending || updateMutation.isPending}
            >
              {editingId
                ? (updateMutation.isPending ? t('compliance.saving') : t('compliance.save'))
                : (createMutation.isPending ? t('compliance.creating') : t('compliance.createPolicy'))}
            </Button>
          </div>
        </form>
      )}

      {/* Tabs */}
      <div className="segmented-control mb-5">
        {(['policies', 'results'] as const).map(tab => (
          <button aria-pressed={activeTab === tab}
            key={tab}
            onClick={() => setActiveTab(tab)}
            className="segment"
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
            <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
              <Table.Header variant="compact">
                <Table.Row className="text-secondary text-xs font-medium uppercase tracking-wider border-b border-strong">
                  <Table.Head className="px-4 py-3 text-left">{t('compliance.policy')}</Table.Head>
                  <Table.Head className="px-4 py-3 text-left">{t('compliance.rules')}</Table.Head>
                  <Table.Head className="px-4 py-3 text-left">{t('compliance.severity')}</Table.Head>
                  <Table.Head className="px-4 py-3 text-left">{t('common.status')}</Table.Head>
                  <Table.Head className="px-4 py-3" />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {policies.map(p => (
                  <Table.Row key={p.id} className="border-b border-strong/50 last:border-0">
                    <Table.Cell className="px-4 py-3">
                      <p className="text-primary font-medium">{p.name}</p>
                      {p.description && <p className="text-muted text-xs mt-0.5">{p.description}</p>}
                    </Table.Cell>
                    <Table.Cell className="px-4 py-3">
                      {Array.isArray(p.rules) && p.rules.length > 0 ? (
                        <span className="text-secondary text-sm">
                          {t('compliance.rulesCount', { count: p.rules.length })}
                        </span>
                      ) : (
                        <span className="text-muted text-sm">{t('compliance.noRules')}</span>
                      )}
                    </Table.Cell>
                    <Table.Cell className="px-4 py-3">
                      {p.severity ? (
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${SEVERITY_COLORS[p.severity] ?? 'bg-emphasis text-secondary'}`}>
                          {t(`status.${p.severity}`, { defaultValue: p.severity })}
                        </span>
                      ) : <span className="text-muted">—</span>}
                    </Table.Cell>
                    <Table.Cell className="px-4 py-3">
                      <span className={`text-sm ${p.is_active ? 'text-success' : 'text-muted'}`}>
                        {p.is_active ? t('common.active') : t('common.inactive')}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="px-4 py-3 text-right whitespace-nowrap">
                      <Button
                        size="sm" variant="ghost"
                        onClick={() => openEdit(p)}
                        className="mr-3"
                      >
                        {t('common.edit')}
                      </Button>
                      <Button
                        size="sm" variant="ghost"
                        onClick={() => toggleMutation.mutate(p)}
                        className="mr-3"
                      >
                        {p.is_active ? t('compliance.deactivate') : t('compliance.activate')}
                      </Button>
                      <Button
                        size="sm" variant="secondary-destructive"
                        onClick={() => deleteMutation.mutate(p.id)}
                      >
                        {t('common.delete')}
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table></div>
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
            <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
              <Table.Header variant="compact">
                <Table.Row className="text-secondary text-xs font-medium uppercase tracking-wider border-b border-strong">
                  <Table.Head className="px-4 py-3 text-left">{t('compliance.ci')}</Table.Head>
                  <Table.Head className="px-4 py-3 text-left">{t('compliance.policy')}</Table.Head>
                  <Table.Head className="px-4 py-3 text-left">{t('common.status')}</Table.Head>
                  <Table.Head className="px-4 py-3 text-left">{t('compliance.violations')}</Table.Head>
                  <Table.Head className="px-4 py-3 text-left">{t('compliance.checked')}</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {results.map(r => (
                  <Table.Row key={r.id} className="border-b border-strong/50 last:border-0 align-top">
                    <Table.Cell className="px-4 py-3 text-primary font-medium">{r.ci_name}</Table.Cell>
                    <Table.Cell className="px-4 py-3 text-secondary text-sm">{r.policy_name}</Table.Cell>
                    <Table.Cell className="px-4 py-3">
                      <span className={`text-sm font-medium ${STATUS_COLORS[r.status ?? 'unknown'] ?? 'text-secondary'}`}>
                        {t(`status.${r.status ?? 'unknown'}`, { defaultValue: r.status ?? 'unknown' })}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="px-4 py-3">
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
                    </Table.Cell>
                    <Table.Cell className="px-4 py-3 text-muted text-xs">
                      {new Date(r.checked_at).toLocaleString()}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table></div>
          </div>
        )
      )}
    </div>
  )
}
