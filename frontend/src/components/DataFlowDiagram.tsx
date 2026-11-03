import { ArrowRight, Cloud, Database, Layers, Receipt, Server, Wallet } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

const lanes = [
  { key: 'inventory', steps: [
    { to: '/cloud-accounts', key: 'source', icon: Cloud },
    { to: '/resources', key: 'resources', icon: Server },
    { to: '/cmdb', key: 'cis', icon: Database },
  ] },
  { key: 'billing', steps: [
    { to: '/billing-import', key: 'bills', icon: Receipt },
    { to: '/expenses', key: 'daily', icon: Layers },
    { to: '/showback', key: 'allocation', icon: Wallet },
  ] },
]

export default function DataFlowDiagram() {
  const { t } = useTranslation()
  return <div className="space-y-4">
    {lanes.map((lane) => <div key={lane.key}>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{t(`flow.lane.${lane.key}`)}</p>
      <ol className="grid gap-3 md:grid-cols-3">
        {lane.steps.map(({ to, key, icon: Icon }, index) => <li key={key} className="min-w-0">
          <Link to={to} className="flex h-full items-start gap-3 rounded-xl border border-edge bg-subtle p-4 hover:border-strong">
            <Icon className="mt-0.5 shrink-0 text-accent" size={20} aria-hidden="true" />
            <div className="min-w-0 flex-1"><p className="font-semibold text-primary">{t(`flow.step.${key}`)}</p><p className="mt-1 text-xs leading-5 text-secondary">{t(`flow.step.${key}.detail`)}</p></div>
            {index < 2 && <ArrowRight size={15} className="mt-1 hidden shrink-0 text-muted md:block" aria-hidden="true" />}
          </Link>
        </li>)}
      </ol>
    </div>)}
    <p className="rounded-lg bg-accent-soft px-4 py-3 text-sm leading-6 text-accent">{t('flow.identity')}</p>
  </div>
}
