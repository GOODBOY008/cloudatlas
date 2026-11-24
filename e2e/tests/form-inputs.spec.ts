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
