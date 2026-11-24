import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../../components/shared/SelectField'
import { useEffect, useId, useRef, useState } from 'react'
import { LocateFixed, Minus, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { chartColors, providerChartColors } from '../../lib/chartTheme'
import { fmtMoney } from '../../lib/format'
import { useThemeStore } from '../../store/themeStore'
import type { createGlobe } from './globeScene'
import { regionKey, type RegionExpense, type WorldGeography } from './regions'
import './costGlobe.css'

type Globe = ReturnType<typeof createGlobe>

export function CostGlobe({ geography, regions, currency, onUnavailable }: {
  geography: WorldGeography
  regions: RegionExpense[]
  currency: string
  onUnavailable: () => void
}) {
  const { t } = useTranslation()
  const theme = useThemeStore(state => state.theme)
  const viewport = useRef<HTMLDivElement>(null)
  const markers = useRef<HTMLDivElement>(null)
  const instructions = useId()
  const [globe, setGlobe] = useState<Globe | null>(null)
  const [selectedKey, setSelectedKey] = useState('')
  const selected = regions.find(entry => regionKey(entry) === selectedKey) ?? regions[0]
  const lat = selected?.coordinates.lat
  const lon = selected?.coordinates.lon
  const maxCost = regions.reduce((max, entry) => Math.max(max, entry.total_cost), 1)

  useEffect(() => {
    let cancelled = false
    let instance: Globe | undefined
    import('./globeScene').then(({ createGlobe }) => {
      if (cancelled || !viewport.current) return
      instance = createGlobe(viewport.current, geography, onUnavailable)
      setGlobe(instance)
    }).catch(() => { if (!cancelled) onUnavailable() })
    return () => { cancelled = true; instance?.dispose() }
  }, [geography, onUnavailable])

  useEffect(() => { globe?.refreshTheme() }, [globe, theme])
  useEffect(() => {
    if (!globe || !markers.current) return
    const buttons = markers.current.querySelectorAll('button')
    globe.setMarkers(regions.map((entry, i) => ({ coordinates: entry.coordinates, element: buttons[i] })))
  }, [globe, regions])
  useEffect(() => {
    globe?.focus(lat !== undefined && lon !== undefined ? { lat, lon } : undefined)
  }, [globe, lat, lon])

  return (
    <div className="cost-globe">
      <div className="cost-globe-stage">
        <div ref={viewport} className="cost-globe-viewport" tabIndex={0} role="group"
          aria-label={t('costMap.globe')} aria-describedby={instructions}>
          <div ref={markers} className="cost-globe-markers">
            {regions.map(entry => {
              const size = 8 + 18 * Math.sqrt(Math.max(0, entry.total_cost) / maxCost)
              return (
                <button key={regionKey(entry)} type="button" className="cost-globe-marker"
                  aria-pressed={entry === selected} aria-label={`${entry.label} · ${entry.cloud_type.toUpperCase()} · ${entry.region}`}
                  style={{ color: providerChartColors[entry.cloud_type] ?? chartColors.muted }}
                  onClick={() => entry === selected ? globe?.focus(entry.coordinates) : setSelectedKey(regionKey(entry))}>
                  <span className="cost-globe-dot" style={{ width: size, height: size }} />
                  {entry === selected && <span className="cost-globe-label">{entry.label || entry.region}</span>}
                </button>
              )
            })}
          </div>
        </div>
        {!globe && <div className="absolute inset-0 skeleton" role="status" aria-label={t('common.loading')} />}
        <div className="absolute bottom-3 right-3 flex rounded border border-edge bg-surface shadow-sm">
          <Button variant="ghost" shape="square" type="button" disabled={!globe} onClick={() => globe?.zoom(false)}
            aria-label={t('costMap.zoomOut')} title={t('costMap.zoomOut')}><Minus size={16} /></Button>
          <Button variant="ghost" shape="square" type="button" disabled={!globe} onClick={() => globe?.zoom(true)}
            aria-label={t('costMap.zoomIn')} title={t('costMap.zoomIn')}><Plus size={16} /></Button>
          <Button variant="ghost" shape="square" type="button" disabled={!globe} onClick={() => globe?.focus(selected?.coordinates, true)}
            aria-label={t('costMap.resetFit')} title={t('costMap.resetFit')}><LocateFixed size={16} /></Button>
        </div>
      </div>
      <div className="cost-globe-details">
        {selected ? (
          <>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-secondary">
              {t('cmdb.region')}
              <SelectField
                aria-label={t('cmdb.region')}
                className="w-full min-w-0"
                value={regionKey(selected)}
                onValueChange={setSelectedKey}
                items={regions.map(entry => ({ value: regionKey(entry), label: `${entry.label || entry.region} · ${entry.cloud_type.toUpperCase()} · ${entry.region}` }))}
              />
            </label>
            <dl className="mt-5 space-y-2 text-xs">
              <div className="mb-4">
                <dt className="text-muted">{t('costMap.cost')}</dt>
                <dd className="mt-1 break-words text-2xl font-semibold tabular-nums text-primary">{fmtMoney(selected.total_cost, currency)}</dd>
              </div>
              <div className="flex justify-between gap-2"><dt className="text-muted">{t('costMap.share')}</dt><dd>{selected.pct}%</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted">{t('costMap.resources')}</dt><dd>{selected.resource_count}</dd></div>
            </dl>
          </>
        ) : <p className="text-sm text-secondary">{t('costMap.noMappedRegions')}</p>}
        <p id={instructions} className="mt-5 text-xs leading-relaxed text-muted">{t('costMap.globeHint')}</p>
      </div>
    </div>
  )
}
