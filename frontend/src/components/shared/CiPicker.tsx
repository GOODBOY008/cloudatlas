import { Input } from '@cloudflare/kumo/components/input'
import { SelectField } from './SelectField'
import { useDeferredValue, useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../../lib/api'
import type { CI } from '../../types'

interface CiPickerProps {
  orgId: string
  ciTypeId?: string
  excludeIds: string[]
  value: string
  onChange: (id: string) => void
  placeholder: string
}

export function CiPicker({ orgId, ciTypeId, excludeIds, value, onChange, placeholder }: CiPickerProps) {
  const { t } = useTranslation()
  const searchId = useId()
  const selectId = useId()
  const [search, setSearch] = useState('')
  const queryText = useDeferredValue(search.trim())
  const query = useQuery({
    queryKey: ['ci-picker', orgId, ciTypeId, queryText],
    queryFn: async ({ signal }) => {
      const { data } = await api.get<{ data: CI[] }>(`/orgs/${orgId}/cis`, {
        params: { ci_type_id: ciTypeId, search: queryText || undefined, per_page: 50 },
        signal,
      })
      return data.data
    },
  })
  const loading = query.isPending || queryText !== search.trim()
  const options = loading ? [] : (query.data ?? []).filter(ci => !excludeIds.includes(ci.id))

  return (
    <>
      <search className="space-y-1">
        <Input label={t('cmdb.searchCiPicker')}
          id={searchId}
          name="searchCi"
          type="search"
          autoCapitalize="none"
          spellCheck={false}
          value={search}
          onChange={event => {
            setSearch(event.target.value)
            onChange('')
          }}
          className="w-full"
        />
      </search>
      <div className="space-y-1">
        <SelectField
          label={t('cmdb.targetCi')}
          id={selectId}
          name="targetCi"
          required
          value={value}
          onValueChange={onChange}
          className="w-full"
          items={[
            { value: "", label: placeholder },
            ...options.map(ci => {
            const name = ci.display_name || ci.name
            return { value: ci.id, label: `${name}${ci.cloud_resource_id && ci.cloud_resource_id !== name ? ' · ' + ci.cloud_resource_id : ''}` }
          }),
          ]}
        />
        {loading && <p role="status" className="text-xs text-muted">{t('common.loading')}</p>}
        {query.isError && <p role="alert" className="text-xs text-danger">{t('cmdb.ciPickerLoadFailed')}</p>}
        {!loading && !query.isError && options.length === 0 && (
          <p role="status" className="text-xs text-muted">{t('cmdb.ciPickerEmpty')}</p>
        )}
      </div>
    </>
  )
}
