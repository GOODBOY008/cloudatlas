import type { Locator } from '@playwright/test';

export async function chooseOption(trigger: Locator, name: string | RegExp) {
  await trigger.click();
  await trigger.page().getByRole('listbox').getByRole('option', { name, exact: typeof name === 'string' }).click();
}
