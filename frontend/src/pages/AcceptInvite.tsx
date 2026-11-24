import { Button } from '@cloudflare/kumo/components/button'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { UserPlus } from 'lucide-react'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import type { ApiResponse, Organization, User } from '../types'

export default function AcceptInvite() {
  const [params] = useSearchParams()
  const token = params.get('token')?.trim() ?? ''
  return <InviteConfirmation key={token} token={token} />
}

function InviteConfirmation({ token }: { token: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [acceptedOrgId, setAcceptedOrgId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const identity = useQuery({
    queryKey: ['auth', 'me'],
    enabled: !!token,
    queryFn: async () => (await api.get<ApiResponse<User>>('/auth/me')).data.data,
  })

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  async function accept() {
    if (inFlight.current || !token || !identity.data) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    let orgId = acceptedOrgId
    try {
      if (!orgId) {
        const { data } = await api.post<ApiResponse<{ organization_id: string }>>('/auth/accept-invite', { token })
        orgId = data.data.organization_id
        if (!mounted.current) return
        setAcceptedOrgId(orgId)
      }
      // If this read fails, retry only the read: acceptance already succeeded.
      const { data } = await api.get<ApiResponse<Organization[]>>('/organizations')
      if (!mounted.current) return
      const organization = data.data.find(item => item.id === orgId)
      if (!organization) throw new Error('Accepted workspace is not available yet')
      useOrgStore.getState().setOrganizations(data.data)
      useOrgStore.getState().setCurrentOrg(organization)
      navigate('/dashboard', { replace: true })
    } catch {
      if (mounted.current) setError(orgId ? 'invite.workspaceLoadFailed' : 'invite.failed')
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return <div className="space-y-6">
    <div className="page-header"><div><h1 className="page-title">{t('invite.title')}</h1><p className="page-description">{t('invite.description')}</p></div></div>
    <section className="panel max-w-2xl space-y-5 p-6" aria-labelledby="invite-heading">
      <UserPlus className="text-accent" size={28} aria-hidden="true" />
      <h2 id="invite-heading" className="panel-title">{t(acceptedOrgId ? 'invite.accepted' : 'invite.confirm')}</h2>
      {!token ? <p role="alert" className="text-sm text-danger">{t('invite.missingToken')}</p> : <>
        {identity.isPending && <div className="skeleton h-12" role="status" aria-label={t('common.loading')} />}
        {identity.isError && <div role="alert" className="space-y-3"><p className="text-sm text-danger">{t('invite.identityFailed')}</p><Button onClick={() => void identity.refetch()}>{t('invite.retry')}</Button></div>}
        {identity.data && <>
          <p className="text-sm text-secondary">{t('invite.signedInAs', { email: identity.data.email })}</p>
          <p className="text-sm leading-6 text-muted">{t(acceptedOrgId ? 'invite.acceptedHint' : 'invite.confirmHint')}</p>
          {error && <p role="alert" className="rounded-lg border border-danger/25 bg-danger/10 p-3 text-sm text-danger">{t(error)}</p>}
          <Button variant="primary" disabled={busy} onClick={() => void accept()}>{t(busy ? 'common.loading' : acceptedOrgId ? 'invite.openWorkspace' : 'invite.accept')}</Button>
        </>}
      </>}
      <div><Link className="text-link text-sm" to="/dashboard">{t('invite.back')}</Link></div>
    </section>
  </div>
}
