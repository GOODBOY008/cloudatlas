import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('cloudatlas-language', 'en'));
});

test('help search preserves fast typing, article links and browser history', async ({ page }) => {
  await page.goto('/help?article=cmdb&q=cost');
  const search = page.getByRole('searchbox');
  await expect(search).toHaveValue('cost');
  await search.fill('');
  await search.pressSequentially('missing-abcdefghijklmnop');
  await expect(search).toHaveValue('missing-abcdefghijklmnop');
  await expect(page).toHaveURL(/article=cmdb&q=missing-abcdefghijklmnop$/);
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toHaveValue('');
  await page.goBack();
  await expect(search).toHaveValue('missing-abcdefghijklmnop');
  await page.goForward();
  await expect(search).toHaveValue('');
  await expect(page.getByRole('heading', { name: 'Get started', exact: true })).toBeVisible();
});

test('CI audit name waits for submission and clears its server filter', async ({ page }) => {
  const names: (string | null)[] = [];
  await page.route('**/cmdb/audit-logs?*', route => {
    const name = new URL(route.request().url()).searchParams.get('ci_name');
    names.push(name);
    const data = name === 'no match' ? [] : [{
      id: 'row', ci_name: '数据库-01', resource_type: 'ci', operation: 'update',
      created_at: '2026-11-01T00:00:00Z',
    }];
    return route.fulfill({ json: { data, meta: { total: data.length, page: 1, per_page: 50, total_pages: 1 } } });
  });
  await page.goto('/cmdb-audit');
  const row = page.getByRole('cell', { name: '数据库-01' });
  await expect(row).toBeVisible();
  const field = page.getByRole('searchbox', { name: 'CI Name' });
  await page.locator('label').filter({ hasText: 'CI Name' }).click();
  await expect(field).toBeFocused();
  await field.fill(' 数据库 ');
  await field.dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 });
  const clear = page.getByRole('button', { name: /Clear filters/ });
  await expect(clear).toHaveCount(0);
  await field.press('Enter');
  await expect.poll(() => names.filter(Boolean)).toEqual(['数据库']);
  await field.fill('no match');
  await page.locator('form').getByRole('button', { name: 'Search', exact: true }).click();
  await expect(row).toHaveCount(0);
  await clear.click();
  await expect(field).toHaveValue('');
  await expect(row).toBeVisible();
  expect(names.filter(Boolean)).toEqual(['数据库', 'no match']);
});

test('resource search stays in place when the result count shrinks on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/orgs/*/resources?*', route => {
    const total = new URL(route.request().url()).searchParams.has('search') ? 0 : 3108;
    return route.fulfill({ json: { data: [], meta: { page: 1, per_page: 50, total, total_pages: Math.ceil(total / 50) } } });
  });
  await page.goto('/resources');
  await expect(page.getByText('3,108 total', { exact: true })).toBeVisible();
  const field = page.getByRole('textbox', { name: /Search by name/ });
  await field.focus();
  const initialY = (await field.boundingBox())!.y;
  await field.pressSequentially('none');
  await expect(page.getByText('0 total', { exact: true })).toBeVisible();
  await expect(field).toHaveValue('none');
  await expect(field).toBeFocused();
  expect(Math.abs((await field.boundingBox())!.y - initialY)).toBeLessThanOrEqual(1);
});

test('auto-release hours allow clearing and retyping while preserving numeric payloads and defaults', async ({ page }) => {
  const submitted: number[] = [];
  await page.route('**/api/v1/orgs/*/shared-environments', route => {
    if (route.request().method() === 'POST') {
      submitted.push(route.request().postDataJSON().auto_release_hours);
      return route.fulfill({ status: 201, json: { data: {} } });
    }
    return route.fulfill({ json: { data: [] } });
  });
  await page.goto('/shared-environments');
  for (const value of ['37', '']) {
    await page.getByRole('button', { name: '+ New Environment' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: /^Name/ }).fill('Input test');
    const hours = dialog.getByRole('spinbutton', { name: /Auto-Release/ });
    await expect(hours).toHaveValue('8');
    await hours.fill('');
    await expect(hours).toHaveValue('');
    if (value) await hours.pressSequentially(value);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  expect(submitted).toEqual([37, 8]);
});

test('exchange rates preserve fractional edits and neighboring currencies', async ({ page }) => {
  const rates = [
    { from_currency: 'CNY', to_currency: 'USD', rate: 0.14, updated_at: null },
    { from_currency: 'JPY', to_currency: 'USD', rate: 0.00645, updated_at: null },
  ];
  let submitted;
  await page.route('**/exchange-rates', route => {
    if (route.request().method() === 'PUT') submitted = route.request().postDataJSON().rates;
    return route.fulfill({ json: { data: rates } });
  });
  await page.goto('/settings');
  const field = page.getByRole('spinbutton', { name: /CNY → USD/ });
  const save = page.getByRole('button', { name: 'Save Rates' });
  await field.fill('');
  await expect(field).toHaveValue('');
  await expect(save).toBeDisabled();
  await field.pressSequentially('0.1425');
  await expect(field).toHaveValue('0.1425');
  await save.click();
  await expect.poll(() => submitted).toEqual([{ ...rates[0], rate: 0.1425 }, rates[1]]);
});

test('cost center codes preserve middle edits and normalize on submission', async ({ page }) => {
  let submitted;
  await page.route('**/orgs/*/cost-centers', route => {
    if (route.request().method() === 'POST') submitted = route.request().postDataJSON();
    return route.fulfill({ json: { data: [] } });
  });
  await page.goto('/cost-centers');
  await page.getByRole('button', { name: '+ New Cost Center' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Engineering');
  const code = dialog.getByRole('textbox', { name: 'Code' });
  await code.fill('ENG US');
  await code.evaluate((field: HTMLInputElement) => field.setSelectionRange(1, 1));
  await code.pressSequentially('xy');
  await expect(code).toHaveValue('ExyNG US');
  await code.press('Enter');
  await expect.poll(() => submitted).toMatchObject({ code: 'EXYNG-US', parent_id: null });
});
