import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

export async function chooseOption(trigger: HTMLElement, name: string | RegExp) {
  await userEvent.click(trigger)
  await userEvent.click(await screen.findByRole('option', { name }))
}
