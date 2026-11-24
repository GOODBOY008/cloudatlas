import { Select } from '@cloudflare/kumo/components/select'
import type { ReactNode } from 'react'

interface SelectItem {
  value: string
  label: ReactNode
}

interface SelectFieldProps {
  items: SelectItem[]
  value?: string | null
  defaultValue?: string
  onValueChange: (value: string) => void
  id?: string
  name?: string
  required?: boolean
  disabled?: boolean
  label?: ReactNode
  'aria-label'?: string
  'data-testid'?: string
  description?: string
  placeholder?: string
  size?: 'sm' | 'base'
  className?: string
  children?: ReactNode
}

/** Keep layout on the field, and labels, focus and test selectors on Kumo's trigger. */
export function SelectField({ className = '', onValueChange, 'data-testid': testId, ...props }: SelectFieldProps) {
  return (
    <div className={`console-select ${className}`}>
      <Select<string>
        {...props}
        className="w-full"
        render={testId ? <button data-testid={testId} /> : undefined}
        onValueChange={value => { if (value !== null) onValueChange(value) }}
      />
    </div>
  )
}
