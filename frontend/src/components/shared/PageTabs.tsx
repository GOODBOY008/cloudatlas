import { Tabs, type TabsItem } from '@cloudflare/kumo/components/tabs'
import { useTranslation } from 'react-i18next'

export function PageTabs<T extends string>({ value, tabs, onValueChange, className }: {
  value: T
  tabs: (TabsItem & { value: T })[]
  onValueChange: (value: T) => void
  className?: string
}) {
  const { t } = useTranslation()
  return <Tabs
    variant="underline"
    className={className}
    value={value}
    tabs={tabs}
    labels={{ scrollStart: t('design.previousTabs'), scrollEnd: t('design.nextTabs') }}
    onValueChange={value => {
      const selected = tabs.find(tab => tab.value === value)
      if (selected) onValueChange(selected.value)
    }}
  />
}
