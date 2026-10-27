import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Modal } from '../components/shared/Modal'
import { useDialogFocus } from '../lib/hooks/useDialogFocus'

function Editor({ onSave }: { onSave: (name: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Edit name</button>
      {open && (
        <Modal title="Edit record" onClose={() => setOpen(false)}>
          <form onSubmit={(event) => {
            event.preventDefault()
            onSave(new FormData(event.currentTarget).get('name') as string)
            setOpen(false)
          }}>
            <input aria-label="Name" name="name" autoFocus />
            <button type="submit">Save</button>
          </form>
        </Modal>
      )}
    </>
  )
}

function PersistentDialog({ autoFocus }: { autoFocus: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useDialogFocus<HTMLDivElement>(open, () => setOpen(false))
  return (
    <>
      <button onClick={() => setOpen(true)}>Open first</button>
      <button onClick={() => setOpen(true)}>Open second</button>
      {open && (
        <div ref={ref} role="dialog" tabIndex={-1}>
          <button onClick={() => setOpen(false)}>Close</button>
          <input aria-label="Search" autoFocus={autoFocus} />
        </div>
      )}
    </>
  )
}

beforeEach(() => {
  // jsdom has no layout; expose the rendered controls to the visibility filter.
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect()] as unknown as DOMRectList)
})

afterEach(() => vi.restoreAllMocks())

describe('dialog focus', () => {
  it('preserves form autofocus in StrictMode, submits with Enter, and restores the launcher', async () => {
    const onSave = vi.fn()
    render(<StrictMode><Editor onSave={onSave} /></StrictMode>)
    const launcher = screen.getByRole('button', { name: 'Edit name' })
    await userEvent.click(launcher)
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus()
    await userEvent.keyboard('Renamed{Enter}')
    expect(onSave).toHaveBeenCalledWith('Renamed')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(launcher).toHaveFocus()
  })

  it('contains Tab focus and restores the launcher after Escape or the close button', async () => {
    render(<Editor onSave={vi.fn()} />)
    const launcher = screen.getByRole('button', { name: 'Edit name' })
    await userEvent.click(launcher)
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus()
    await userEvent.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
    await userEvent.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus()
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(launcher).toHaveFocus()

    await userEvent.click(launcher)
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(launcher).toHaveFocus()
  })

  it.each([true, false])('restores the latest launcher on reopening a persistent dialog (autoFocus=%s)', async (autoFocus) => {
    render(<StrictMode><PersistentDialog autoFocus={autoFocus} /></StrictMode>)
    for (const name of ['Open first', 'Open second']) {
      const launcher = screen.getByRole('button', { name })
      await userEvent.click(launcher)
      expect(autoFocus ? screen.getByRole('textbox') : screen.getByRole('button', { name: 'Close' })).toHaveFocus()
      await userEvent.keyboard('{Escape}')
      expect(launcher).toHaveFocus()
    }
  })
})
