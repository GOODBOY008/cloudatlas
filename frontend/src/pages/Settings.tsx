import { PageTabs } from '../components/shared/PageTabs'
import { Table } from '@cloudflare/kumo/components/table'
import { Input, InputArea } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { setOrgCurrency, useOrgCurrency } from '../lib/format'
import AiProviderSection from '../components/settings/AiProviderSection'
import { useOrgStore } from '../store'

interface ApiKeyRow {
  id: string
  name: string
  key_prefix: string
  last_used_at: string | null
  created_at: string
}

interface Member {
  user_id: string
  email: string
  display_name: string
  roles: string[]
  joined_at: string
}

interface InviteForm {
  email: string
  role: string
}

interface OrgDetails {
  id: string
  name: string
  slug: string
  description?: string | null
  settings?: Record<string, unknown>
}

export default function Settings() {
  const { t } = useTranslation()
  const { currentOrg, setCurrentOrg } = useOrgStore()
  const [activeTab, setActiveTab] = useState<'org' | 'keys' | 'security' | 'aiProvider'>('org')
  const queryClient = useQueryClient()
  const [orgForm, setOrgForm] = useState({ name: '', description: '', currency: 'USD' })
  const [orgSaveMsg, setOrgSaveMsg] = useState<string | null>(null)
  const [inviteForm, setInviteForm] = useState<InviteForm>({ email: '', role: 'viewer' })
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteSuccess, setInviteSuccess] = useState(false)

  const orgId = currentOrg?.id

  const { data: members, isLoading } = useQuery<Member[]>({
    queryKey: ['org-members', orgId],
    queryFn: async () => {
      const { data: res } = await api.get<{ data: Member[] }>(`/organizations/${orgId}/members`)
      return res.data ?? []
    },
    enabled: !!orgId,
  })

  const { data: orgDetails } = useQuery<OrgDetails>({
    queryKey: ['org-details', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: OrgDetails }>(`/organizations/${orgId}`)
      return res.data
    },
  })

  useEffect(() => {
    if (!orgDetails) return
    setOrgForm({
      name: orgDetails.name ?? '',
      description: orgDetails.description ?? '',
      currency: (orgDetails.settings as { currency?: string } | undefined)?.currency ?? 'USD',
    })
  }, [orgDetails])

  const updateOrgMutation = useMutation({
    mutationFn: () =>
      api.put<{ data: OrgDetails }>(`/organizations/${orgId}`, {
        name: orgForm.name.trim(),
        description: orgForm.description.trim() || null,
        currency: orgForm.currency,
      }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['org-details', orgId] })
      const state = useOrgStore.getState()
      if (!state.currentOrg || state.currentOrg.id !== orgId) return
      const saved = res.data.data
      const currency = (saved.settings as { currency?: string } | undefined)?.currency ?? orgForm.currency
      const updated = {
        ...state.currentOrg,
        name: saved.name,
        slug: saved.slug ?? state.currentOrg.slug,
        settings: { ...state.currentOrg.settings, currency },
      }
      setOrgCurrency(currency)
      if (state.organizations.some(org => org.id === updated.id)) {
        state.setOrganizations(state.organizations.map(org => org.id === updated.id ? updated : org))
      } else {
        setCurrentOrg(updated)
      }
      setOrgSaveMsg(t('settings.saved'))
      setTimeout(() => setOrgSaveMsg(null), 2500)
    },
    onError: () => setOrgSaveMsg(t('settings.updateFailed')),
  })

  const inviteMutation = useMutation({
    mutationFn: (payload: InviteForm) =>
      api.post(`/organizations/${orgId}/members`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-members', orgId] })
      setInviteForm({ email: '', role: 'viewer' })
      setInviteSuccess(true)
      setInviteError(null)
      setTimeout(() => setInviteSuccess(false), 3000)
    },
    onError: (err: any) => {
      setInviteError(err?.response?.data?.message ?? t('settings.inviteFailed'))
    },
  })

  const removeMutation = useMutation({
    mutationFn: (userId: string) =>
      api.delete(`/organizations/${orgId}/members/${userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-members', orgId] })
    },
  })

  const roleMutation = useMutation({
    mutationFn: ({ userId, roleName }: { userId: string; roleName: string }) =>
      api.put(`/orgs/${orgId}/members/${userId}/role`, { role_name: roleName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-members', orgId] })
    },
  })

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault()
    if (!inviteForm.email) return
    inviteMutation.mutate(inviteForm)
  }

  if (!orgId) {
    return (
      <div className="p-8 text-center text-muted">
        {t('settings.noOrgSelected')}
      </div>
    )
  }

  const orgSection = (
    <div className="space-y-6">
      {/* Organization Info */}
      <div className="bg-surface rounded-xl border border-edge p-6">
        <h3 className="text-base font-semibold text-primary mb-4">{t('settings.organization')}</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            updateOrgMutation.mutate()
          }}
          className="space-y-4"
        >
          <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <SelectField label={t('settings.currency')}
                  value={orgForm.currency ?? 'USD'}
                  onValueChange={value => setOrgForm({ ...orgForm, currency: value })}
                  className="w-full"
                  items={['USD', 'EUR', 'GBP', 'CNY', 'JPY', 'AUD', 'CAD'].map((c) => ({ value: c, label: c }))}
                />
              </div>
            <div>
              <Input
                label={t('settings.name')}
                value={orgForm.name}
                onChange={(e) => setOrgForm((s) => ({ ...s, name: e.target.value }))}
                className="w-full"
              />
            </div>
            <div>
              <span className="text-muted block mb-1">{t('settings.slug')}</span>
              <span className="font-medium font-mono text-secondary">{currentOrg?.slug}</span>
            </div>
          </div>
          <div>
            <InputArea
              label={t('settings.description')}
              value={orgForm.description}
              onChange={(e) => setOrgForm((s) => ({ ...s, description: e.target.value }))}
              rows={2}
              className="w-full resize-y"
            />
          </div>
          <div>
            <span className="text-muted block mb-1">{t('settings.id')}</span>
            <span className="font-medium font-mono text-xs text-muted">{currentOrg?.id}</span>
          </div>
          <div className="flex items-center justify-end gap-3 pt-1">
            {orgSaveMsg && <span className="text-xs text-secondary">{orgSaveMsg}</span>}
            <Button
              variant="primary"
              type="submit"
              disabled={updateOrgMutation.isPending || !orgForm.name.trim()}
            >
              {updateOrgMutation.isPending ? t('common.loading') : t('settings.save')}
            </Button>
          </div>
        </form>
      </div>

      {/* Exchange rates */}
      <FxRatesSection />

      {/* Members */}
      <div className="bg-surface rounded-xl border border-edge p-6">
        <h3 className="text-base font-semibold text-primary mb-4">{t('settings.members')}</h3>

        {/* Invite Form */}
        <form onSubmit={handleInvite} className="flex flex-wrap gap-3 mb-5">
          <Input
            aria-label={t('settings.emailPlaceholder')}
            type="email"
            placeholder={t('settings.emailPlaceholder')}
            value={inviteForm.email}
            onChange={(e) => setInviteForm((f) => ({ ...f, email: e.target.value }))}
            className="min-w-0 basis-full sm:basis-auto flex-1"
            required
          />
          <SelectField
            value={inviteForm.role}
            onValueChange={value => setInviteForm((f) => ({ ...f, role: value }))}
            aria-label={t('settings.role.viewer')}
            items={[
              { value: "viewer", label: t('settings.role.viewer') },
              { value: "finops", label: t('settings.role.finops') },
              { value: "cmdb_editor", label: t('settings.role.cmdbEditor') },
              { value: "admin", label: t('settings.role.admin') },
            ]}
          />
          <Button
            variant="primary"
            type="submit"
            disabled={inviteMutation.isPending}
          >
            {inviteMutation.isPending ? t('settings.inviting') : t('settings.invite')}
          </Button>
        </form>

        {inviteError && (
          <div className="mb-4 p-3 rounded-lg bg-danger/10 border border-danger/25 text-danger text-sm">
            {inviteError}
          </div>
        )}
        {inviteSuccess && (
          <div className="mb-4 p-3 rounded-lg bg-success/10 border border-success/25 text-success text-sm">
            {t('settings.inviteSuccess')}
          </div>
        )}

        {/* Member list */}
        {isLoading ? (
          <p className="text-muted text-sm">{t('settings.loadingMembers')}</p>
        ) : (
          <div className="divide-y divide-edge">
            {(members ?? []).map((m) => (
              <div key={m.user_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-medium text-primary">{m.display_name || m.email}</p>
                  <p className="text-xs text-muted">{m.email}</p>
                </div>
                <div className="flex items-center gap-4">
                  <SelectField
                    value={(m.roles?.[0] ?? t('settings.role.member')).toLowerCase()}
                    onValueChange={value => roleMutation.mutate({ userId: m.user_id, roleName: value })}
                    aria-label={t('settings.role.owner')}
                    items={[
                      { value: "owner", label: t('settings.role.owner') },
                      { value: "admin", label: t('settings.role.admin') },
                      { value: "member", label: t('settings.role.member') },
                      { value: "viewer", label: t('settings.role.viewer') },
                    ]}
                  />
                  <button
                    onClick={() => removeMutation.mutate(m.user_id)}
                    disabled={removeMutation.isPending}
                    className="text-xs text-danger hover:text-danger hover:underline disabled:opacity-50 transition-colors"
                  >
                    {t('settings.removeMember')}
                  </button>
                </div>
              </div>
            ))}
            {(members ?? []).length === 0 && (
              <p className="text-sm text-muted py-3">{t('settings.noMembers')}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )

  return (
    <div>
      <div className="page-header"><h1 className="page-title">{t('settings.title')}</h1></div>
      <PageTabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="mb-6"
        tabs={[
          { value: 'org', label: t('settings.organization') },
          { value: 'keys', label: t('settings.apiKeys') },
          { value: 'security', label: t('settings.security') },
          { value: 'aiProvider', label: t('settings.aiProvider') },
        ]}
      />
      {activeTab === 'org' && orgSection}
      {activeTab === 'keys' && <ApiKeysSection />}
      {activeTab === 'security' && <SecuritySection />}
      {activeTab === 'aiProvider' && <AiProviderSection />}
    </div>
  )
}

// ─── FX Rates (currency normalization) ────────────────────────────────────────

interface FxRate {
  from_currency: string
  to_currency: string
  rate: number
  updated_at: string
}

function FxRatesSection() {
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const [rates, setRates] = useState<FxRate[]>([])
  const orgCurrency = useOrgCurrency()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!orgId) return
    api
      .get<{ data: FxRate[]; org_currency: string }>(`/orgs/${orgId}/exchange-rates`)
      .then((res) => {
        setRates(res.data.data ?? [])
        setLoaded(true)
      })
      .catch(() => setError(t('settings.fxLoadFailed')))
  }, [orgId, t])

  function updateRate(idx: number, value: string) {
    const v = parseFloat(value)
    setRates((prev) => prev.map((r, i) => (i === idx ? { ...r, rate: isNaN(v) ? 0 : v } : r)))
  }

  async function save() {
    if (!orgId) return
    setSaving(true)
    setMessage('')
    setError('')
    try {
      await api.put(`/orgs/${orgId}/exchange-rates`, { rates })
      setMessage(t('settings.fxSaved'))
    } catch {
      setError(t('settings.fxSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-surface rounded-xl border border-edge p-6">
      <h3 className="text-base font-semibold text-primary mb-1">{t('settings.fxRates')}</h3>
      <p className="text-xs text-muted mb-1">{t('settings.fxOrgCurrency', { currency: orgCurrency })}</p>
      <p className="text-xs text-muted mb-4">{t('settings.fxHint')}</p>
      {error && <p className="text-xs text-danger mb-3">{error}</p>}
      {message && <p className="text-xs text-success mb-3">{message}</p>}
      {loaded && rates.length === 0 ? (
        <p className="text-sm text-muted">{t('settings.fxNoRates')}</p>
      ) : (
        <div className="overflow-x-auto">
          <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table className="text-left">
            <Table.Header variant="compact" className="border-b border-edge">
              <Table.Row>
                <Table.Head className="px-3 py-2 font-medium">{t('settings.fxFrom')}</Table.Head>
                <Table.Head className="px-3 py-2 font-medium">{t('settings.fxTo')}</Table.Head>
                <Table.Head className="px-3 py-2 font-medium">{t('settings.fxRate')}</Table.Head>
                <Table.Head className="px-3 py-2 font-medium">{t('settings.fxUpdated')}</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rates.map((r, idx) => (
                <Table.Row key={`${r.from_currency}-${r.to_currency}`} className="border-b border-edge last:border-0">
                  <Table.Cell className="px-3 py-2 text-sm font-mono text-primary">{r.from_currency}</Table.Cell>
                  <Table.Cell className="px-3 py-2 text-sm font-mono text-primary">{r.to_currency}</Table.Cell>
                  <Table.Cell className="px-3 py-2">
                    <Input
                      type="number"
                      step="0.0001"
                      min="0"
                      aria-label={`${t('settings.fxRate')} · ${r.from_currency} → ${r.to_currency}`}
                      value={r.rate}
                      onChange={(e) => updateRate(idx, e.target.value)}
                      className="w-32 font-mono"
                    />
                  </Table.Cell>
                  <Table.Cell className="px-3 py-2 text-xs text-muted">
                    {r.updated_at ? new Date(r.updated_at).toLocaleString() : '—'}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table></div>
        </div>
      )}
      {rates.length > 0 && (
        <div className="flex justify-end mt-4">
          <Button
            variant="primary"
            onClick={save}
            disabled={saving}
          >
            {saving ? t('common.loading') : t('settings.fxSave')}
          </Button>
        </div>
      )}
    </div>
  )
}

// ─── API Keys (I1) ────────────────────────────────────────────────────────────

function ApiKeysSection() {
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const [name, setName] = useState('')
  const [keys, setKeys] = useState<ApiKeyRow[]>([])
  const [revealed, setRevealed] = useState<{ key: string; name: string } | null>(null)
  const [error, setError] = useState('')

  function loadKeys() {
    if (!orgId) return
    api
      .get<{ data: ApiKeyRow[] }>(`/orgs/${orgId}/api-keys`)
      .then((res) => setKeys(res.data.data ?? []))
      .catch(() => {})
  }
  useEffect(() => {
    loadKeys()
  }, [orgId])

  async function createKey() {
    if (!orgId || !name.trim()) return
    try {
      const { data: res } = await api.post<{ data: { key: string; name: string } }>(
        `/orgs/${orgId}/api-keys`,
        { name: name.trim() }
      )
      setRevealed(res.data)
      setName('')
      setError('')
      loadKeys()
    } catch {
      setError(t('settings.saveFailed'))
    }
  }

  async function revokeKey(id: string) {
    if (!orgId) return
    await api.delete(`/orgs/${orgId}/api-keys/${id}`)
    loadKeys()
  }

  return (
    <div className="bg-surface rounded-xl border border-edge p-6">
      <h3 className="text-base font-semibold text-primary mb-4">{t('settings.apiKeys')}</h3>
      <div className="flex flex-wrap gap-2 mb-4">
        <Input
          aria-label={t('settings.keyName')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('settings.keyName')}
          className="w-full flex-1"
        />
        <Button
          variant="primary"
          onClick={createKey}
        >
          {t('settings.createKey')}
        </Button>
      </div>
      {error && <p className="text-xs text-danger mb-3">{error}</p>}
      {revealed && (
        <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
          <p className="font-medium mb-1">{t('settings.keyCreated')}</p>
          <code className="text-xs break-all">{revealed.key}</code>
        </div>
      )}
      {keys.length === 0 ? (
        <p className="text-sm text-muted">{t('settings.noKeys')}</p>
      ) : (
        <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table className="text-left">
          <Table.Header variant="compact" className="border-b border-edge">
            <Table.Row>
              <Table.Head className="px-3 py-2 font-medium">{t('settings.name')}</Table.Head>
              <Table.Head className="px-3 py-2 font-medium">{t('settings.keyPrefix')}</Table.Head>
              <Table.Head className="px-3 py-2 font-medium">{t('settings.keyLastUsed')}</Table.Head>
              <Table.Head className="px-3 py-2 font-medium">{t('common.actions')}</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {keys.map((k) => (
              <Table.Row key={k.id} className="border-b border-edge last:border-0">
                <Table.Cell className="px-3 py-2 text-sm text-primary">{k.name}</Table.Cell>
                <Table.Cell className="px-3 py-2 text-xs font-mono text-secondary">{k.key_prefix}…</Table.Cell>
                <Table.Cell className="px-3 py-2 text-xs text-muted">
                  {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : t('common.never')}
                </Table.Cell>
                <Table.Cell className="px-3 py-2">
                  <Button size="sm" variant="secondary-destructive" onClick={() => revokeKey(k.id)}>
                    {t('settings.revokeKey')}
                  </Button>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table></div>
      )}
    </div>
  )
}

// ─── Security / 2FA (I5) ──────────────────────────────────────────────────────

function SecuritySection() {
  const { t } = useTranslation()
  const [secret, setSecret] = useState('')
  const [otpauth, setOtpauth] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function enroll() {
    setError('')
    try {
      const { data: res } = await api.post<{ data: { secret: string; otpauth_url: string } }>(
        '/auth/2fa/enroll',
        { password }
      )
      setSecret(res.data.secret)
      setOtpauth(res.data.otpauth_url)
    } catch {
      setError(t('settings.badPassword'))
    }
  }

  async function verify() {
    setError('')
    try {
      await api.post('/auth/2fa/verify', { password: secret, code })
      setMessage(t('settings.twoFactorEnabled'))
      setSecret('')
      setOtpauth('')
      setCode('')
    } catch {
      setError(t('settings.badCode'))
    }
  }

  async function disable() {
    setError('')
    try {
      await api.post('/auth/2fa/disable', { password })
      setMessage(t('settings.twoFactorDisabled'))
    } catch {
      setError(t('settings.badPassword'))
    }
  }

  return (
    <div className="bg-surface rounded-xl border border-edge p-6 max-w-lg">
      <h3 className="text-base font-semibold text-primary mb-4">{t('settings.twoFactor')}</h3>
      {message && <p className="text-xs text-success mb-3">{message}</p>}
      {error && <p className="text-xs text-danger mb-3">{error}</p>}
      {!secret && !otpauth && (
        <div className="space-y-3">
          <Input
            aria-label={t('settings.currentPassword')}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('settings.currentPassword')}
            className="w-full"
          />
          <Button
            variant="primary"
            onClick={enroll}
          >
            {t('settings.enable2fa')}
          </Button>
        </div>
      )}
      {otpauth && (
        <div className="space-y-3">
          <p className="text-xs text-secondary">{t('settings.scanQr')}</p>
          <code className="block text-xs text-secondary break-all bg-subtle rounded-lg p-2">{otpauth}</code>
          <Input
            aria-label={t('login.totpCode')}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            placeholder={t('login.totpCode')}
            className="w-full"
          />
          <Button
            variant="primary"
            onClick={verify}
          >
            {t('settings.verifyAndEnable')}
          </Button>
        </div>
      )}
      {!otpauth && (
        <button onClick={disable} className="mt-4 text-xs text-danger hover:text-danger">
          {t('settings.disable2fa')}
        </button>
      )}
    </div>
  )
}

