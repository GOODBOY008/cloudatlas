import { expect, test } from '@playwright/test';

test.describe('Cost Map reporting', () => {
  test.use({ timezoneId: 'Asia/Shanghai', locale: 'en-US' });

  test('distinguishes an outage from an empty report and uses UTC dates and workspace currency', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-11-17T09:00:00Z'));
    await page.route('**/api/v1/organizations', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const org of body.data) {
        org.settings = { ...org.settings, currency: 'EUR' };
      }
      await route.fulfill({ response, json: body });
    });
    const isGeography = (url: URL) => /\/countries-110m[^/]*\.json$/.test(url.pathname);
    let failGeography = true;
    await page.route(isGeography, (route) => (failGeography && route.request().resourceType() === 'fetch')
      ? route.fulfill({ status: 503, json: {} })
      : route.continue());
    let fail = true;
    let populated = false;
    await page.route('**/api/v1/orgs/*/expenses/region-expenses?*', (route) => {
      if (fail) return route.fulfill({ status: 503, json: {} });
      const params = new URL(route.request().url()).searchParams;
      return route.fulfill({
        json: {
          total_cost: populated ? 1234.56 : 0,
          start_date: params.get('start_date'),
          end_date: params.get('end_date'),
          expenses: populated ? [{
            region: 'eu-west-1', cloud_type: 'aws', total_cost: 1234.56, resource_count: 3,
            pct: 100, label: 'Ireland', coordinates: { lat: 53.35, lon: -6.26 },
          }] : [],
        },
      });
    });

    await page.goto('/cost-map');
    await expect(page.getByRole('alert')).toContainText('This data could not be loaded');
    const empty = page.getByText('No expense data for this period');
    await expect(empty).toHaveCount(0);
    fail = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(empty).toBeVisible();

    populated = true;
    const request = page.waitForRequest((candidate) => {
      const url = new URL(candidate.url());
      return url.pathname.endsWith('/region-expenses') && url.searchParams.get('start_date') !== '2026-10-19';
    });
    await page.getByRole('button', { name: 'MTD', exact: true }).click();
    const params = new URL((await request).url()).searchParams;
    expect(params.get('start_date')).toBe('2026-11-01');
    expect(params.get('end_date')).toBe('2026-11-17');
    await expect(page.getByRole('cell', { name: '€1,234.56' })).toBeVisible();

    const geographyError = page.getByRole('alert').filter({ hasText: 'See the region breakdown below' });
    await expect(geographyError).toBeVisible();
    failGeography = false;
    const geographyRequest = page.waitForRequest(candidate =>
      candidate.resourceType() === 'fetch' && isGeography(new URL(candidate.url())));
    await geographyError.getByRole('button', { name: 'Retry', exact: true }).click();
    expect(new URL((await geographyRequest).url()).origin).toBe(new URL(page.url()).origin);
    await expect(page.locator('.rsm-geography').first()).toBeAttached();
    await expect(geographyError).toHaveCount(0);
  });
});

test('desktop Copilot floats, remembers drag and resize, and stays beneath search', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/dashboard');
  const main = page.getByRole('main');
  const launcher = page.getByRole('button', { name: 'Open Copilot', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Copilot' });
  await expect(launcher).toBeVisible();
  const mainBefore = await main.boundingBox();
  await launcher.click();
  await expect(dialog.getByRole('textbox')).toBeFocused();
  expect(await main.boundingBox()).toEqual(mainBefore);
  expect(await dialog.boundingBox()).toMatchObject({ width: 400, height: 560 });
  const before = (await dialog.boundingBox())!;
  const title = dialog.getByRole('button', { name: /Move Copilot with arrow keys/ });
  const grip = dialog.getByRole('button', { name: /Resize window with arrow keys/ });
  for (const [handle, dx, dy] of [[title, -160, -48], [grip, -32, -32]] as const) {
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 5 });
    await page.mouse.up();
  }
  const saved = { x: before.x - 192, y: before.y - 80, width: 432, height: 592 };
  await expect.poll(() => dialog.boundingBox()).toEqual(saved);
  await expect(dialog.getByRole('group', { name: 'Window position and size' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Search' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Search' })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').fill('draft');
  await dialog.getByRole('button', { name: 'Send', exact: true }).focus();
  await page.keyboard.press('Tab');
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(false);
  await page.reload();
  await expect(dialog).toHaveCount(0);
  await launcher.click();
  await expect.poll(() => dialog.boundingBox()).toEqual(saved);
  await page.setViewportSize({ width: 1024, height: 420 });
  await expect.poll(async () => {
    const box = (await dialog.boundingBox())!;
    return box.x >= 0 && box.y >= 0 && box.x + box.width <= 1024 && box.y + box.height <= 420;
  }).toBe(true);
});

test('Copilot retains a draft across the desktop breakpoint and a mobile dismissal', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/dashboard');
  const launcher = page.getByRole('button', { name: 'Open Copilot', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Copilot' });
  await launcher.click();
  await dialog.getByRole('textbox').fill('keep this draft');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('dialog:modal')).toHaveCount(1);
  await expect(dialog.getByRole('textbox')).toHaveValue('keep this draft');
  await page.keyboard.press('Escape');
  await expect(launcher).toBeFocused();
  await launcher.click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('dialog:modal')).toHaveCount(0);
  await expect(dialog.getByRole('textbox')).toHaveValue('keep this draft');
});

test('mobile Copilot keeps focus in the modal and returns it to the launcher', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard');
  const launcher = page.getByRole('button', { name: 'Open Copilot' });
  await launcher.click();
  const modal = page.getByRole('dialog', { name: 'Copilot' });
  await expect(modal).toBeVisible();
  await expect(page.locator('dialog:modal')).toHaveCount(1);
  await expect(modal.getByRole('textbox')).toBeFocused();

  for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    // Some browsers offer the browser chrome a tab stop before wrapping.
    expect(await modal.evaluate((dialog) => dialog.contains(document.activeElement)
      || document.activeElement === document.body)).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(launcher).toBeFocused();
});

test('resource details restore keyboard focus and take precedence over desktop Copilot', async ({ page }) => {
  const resource = {
    id: 'keyboard-resource', cloud_resource_id: 'keyboard-resource-cloud-id',
    name: 'Keyboard test resource', resource_type: 'instance', provider: 'aws',
    cloud_region: 'eu-west-1', service_name: 'EC2', active: true,
    total_cost: 1234.56, last_month_cost: 11, pool_id: null, tags: {},
    first_seen: '2026-11-01T00:00:00Z', last_seen: '2026-11-17T00:00:00Z', recommendations: [],
  };
  await page.route('**/api/v1/orgs/*/resources?*', (route) => route.fulfill({
    json: { data: [resource], meta: { total: 1, total_pages: 1, page: 1, per_page: 50 } },
  }));
  await page.route('**/api/v1/orgs/*/resources/keyboard-resource', (route) => route.fulfill({ json: { data: resource } }));
  await page.route('**/api/v1/orgs/*/resources/keyboard-resource/*', (route) => route.fulfill({ json: { data: [] } }));
  await page.goto('/resources');
  await page.getByRole('button', { name: 'Open Copilot' }).click();
  const copilot = page.getByRole('dialog', { name: 'Copilot', exact: true });
  await expect(copilot).toBeVisible();
  const button = page.getByRole('button', { name: resource.name });
  await button.press('Enter');
  const drawer = page.getByRole('dialog', { name: resource.name });
  await expect(drawer.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Escape');
  // Native dismissal hides the drawer before its queued close event unmounts it.
  await expect(page.locator('dialog:not(#copilot-window)')).toHaveCount(0);
  await expect(copilot).toBeVisible();
  await expect(button).toBeFocused();
  await page.keyboard.press('Space');
  await expect(drawer).toBeVisible();
});

test('Chinese IME confirmation stays in Search until a normal Enter', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const input = page.getByRole('combobox', { name: 'Search' });
  await input.fill('审计');
  await expect(page.getByRole('option', { name: /CMDB Audit Log/ })).toBeVisible();
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true, cancelable: true, bubbles: true });
  await input.evaluate((field) => {
    const confirmingEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(confirmingEnter, 'keyCode', { value: 229 });
    field.dispatchEvent(confirmingEnter);
  });
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(input).toBeFocused();
  await input.press('Enter');
  await expect(page).toHaveURL(/\/cmdb-audit$/);
});
