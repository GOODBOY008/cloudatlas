import { chooseOption } from '../helpers/chooseOption';
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

test('Kubernetes estimates retain their USD pricing in a CNY workspace', async ({ page }) => {
  await page.route('**/api/v1/organizations', async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const org of body.data) org.settings = { ...org.settings, currency: 'CNY' };
    await route.fulfill({ response, json: body });
  });
  await page.route('**/k8s/summary', route => route.fulfill({ json: {
    cluster_count: 1, namespace_count: 1, workload_count: 1, total_cost: 32.85, total_savings: 6.25,
    cluster_totals: { prod: { workload_count: 1, total_savings: 6.25 } },
    top_namespaces: [{ namespace: 'payments', cluster_id: 'prod', workload_count: 1, potential_savings: 6.25 }],
  } }));
  await page.route('**/k8s/clusters', route => route.fulfill({ json: { data: [
    { id: 'prod', name: 'Production', namespaces: ['payments'], workload_count: 1, total_savings: 6.25 },
  ], meta: { total: 1, total_pages: 1, per_page: 50 } } }));
  await page.route('**/k8s/workloads*', route => route.fulfill({ json: { data: [
    { id: 'api', cluster_id: 'prod', cluster_name: 'Production', namespace: 'payments', workload_name: 'API',
      workload_type: 'Deployment', observation_days: 14, potential_savings: 6.25 },
  ], meta: { total: 1, total_pages: 1, per_page: 50 } } }));
  await page.goto('/k8s-rightsizing');
  await expect(page.getByText('of $32.85/mo total')).toBeVisible();
  await expect(page.getByText('$6.25', { exact: true })).toHaveCount(2);
  await expect(page.locator('.recharts-xAxis')).toContainText('$0.00');
  await page.locator('.recharts-bar-rectangle path').hover();
  await expect(page.locator('.recharts-tooltip-wrapper')).toContainText('$6.25');
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await expect(page.getByRole('row', { name: /API/ }).getByRole('cell', { name: '$6.25' })).toBeVisible();
});

test('Kubernetes filters keep the namespace choices and scope both views', async ({ page }) => {
  const clusters = [
    { id: 'east', name: 'East cluster', namespaces: ['east-only', 'shared'] },
    { id: 'west', name: 'West cluster', namespaces: ['shared', 'west-only'] },
  ];
  await page.route('**/k8s/clusters*', async route => {
    const index = Number(new URL(route.request().url()).searchParams.get('page') ?? 1) - 1;
    await route.fulfill({ json: { data: [clusters[index]], meta: { per_page: 1, total_pages: 2 } } });
  });
  await page.route('**/k8s/summary*', route => {
    const params = new URL(route.request().url()).searchParams;
    const scoped = clusters.filter(c => !params.has('cluster_id') || c.id === params.get('cluster_id'));
    const totals = Object.fromEntries(scoped.map(c => [c.id, {
      workload_count: params.has('namespace') ? 1 : c.namespaces.length, total_savings: 0,
    }]));
    return route.fulfill({ json: { cluster_count: scoped.length, total_cost: 0, total_savings: 0,
      workload_count: Object.values(totals).reduce((n, c) => n + c.workload_count, 0),
      top_namespaces: [], cluster_totals: totals } });
  });
  await page.route('**/k8s/workloads*', route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { data: [{ id: 'dns', cluster_name: params.get('cluster_id'),
      namespace: params.get('namespace'), workload_name: 'dns', workload_type: 'Deployment' }],
      meta: { total: 1, total_pages: 1, per_page: 50 } } });
  });
  await page.goto('/k8s-rightsizing');
  const cluster = page.getByRole('combobox', { name: 'Cluster', exact: true });
  const namespace = page.getByRole('combobox', { name: 'Namespace', exact: true });
  await chooseOption(namespace, 'east-only');
  await chooseOption(cluster, 'West cluster');
  await expect(namespace).toHaveText('All namespaces');
  await namespace.click();
  await expect(page.getByRole('option')).toHaveText(['All namespaces', 'shared', 'west-only']);
  await page.getByRole('option', { name: 'shared', exact: true }).click();
  const workloadMetric = page.getByText('Workloads', { exact: true }).locator('..');
  await expect(workloadMetric.getByText('1', { exact: true })).toBeVisible();
  await namespace.click();
  await expect(page.getByRole('option')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: /dns/ }) });
  await expect(row.getByRole('cell', { name: 'shared', exact: true })).toBeVisible();
  await expect(row.getByRole('cell', { name: 'west', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await expect(cluster).toHaveText('All Clusters');
  await expect(namespace).toHaveText('All namespaces');
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
  // Cross the dialog boundary inside the document, away from browser chrome.
  const minimizeLauncher = page.getByRole('button', { name: 'Minimize Copilot', exact: true, expanded: true });
  await grip.focus();
  for (const [key, target] of [['Shift+Tab', minimizeLauncher], ['Tab', grip]] as const) {
    await page.keyboard.press(key);
    // Firefox includes the native dialog itself in the tab order.
    if (await dialog.evaluate(element => element === document.activeElement)) {
      await page.keyboard.press(key);
    }
    await expect(target).toBeFocused();
  }
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
  const close = drawer.getByRole('button', { name: 'Close' });
  const search = page.getByRole('dialog', { name: 'Search', includeHidden: true });
  await expect(close).toBeFocused();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toHaveCount(0);
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  // Native dismissal hides the drawer before its queued close event unmounts it.
  await expect(page.locator('dialog:not(#copilot-window)')).toHaveCount(0);
  await expect(copilot).toBeVisible();
  await expect(button).toBeFocused();
  await expect(search).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search.getByRole('combobox')).toBeFocused();
  await page.keyboard.press('Escape');
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

test('model instance search preserves fast typing, clears pagination and follows Back', async ({ page }) => {
  const model = { id: 'servers', name: 'servers', display_name: 'Servers', classification: null, is_builtin: false, ci_count: 0 };
  await page.route('**/cmdb/model-topology', route => route.fulfill({ json: { data: { nodes: [model], edges: [] } } }));
  await page.route('**/cis?*', route => route.fulfill({ json: {
    data: [], meta: { page: 1, total_pages: 1, per_page: 5, total: 0 },
  } }));
  await page.goto('/model-topology?type=servers&q=node-&page=2');
  const search = page.getByRole('searchbox', { name: 'Find an instance' });
  await expect(search).toHaveValue('node-');
  await page.getByText('Find an instance', { exact: true }).click();
  await expect(search).toBeFocused();
  await search.fill('');
  await search.pressSequentially('node-abcdefghijklmnop');
  await expect(search).toHaveValue('node-abcdefghijklmnop');
  await expect(page).toHaveURL(/\?type=servers&q=node-abcdefghijklmnop$/);
  await page.getByRole('button', { name: /^Servers / }).click();
  await expect(search).toHaveValue('');
  await page.goBack();
  await expect(search).toHaveValue('node-abcdefghijklmnop');
});

test('bucket search aligns its icon and keeps focus and position while filtering', async ({ page }) => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  await page.route('**/object-storage?*', async route => {
    if (new URL(route.request().url()).searchParams.get('search') === 'atlas-search-test') await pending;
    await route.continue();
  });
  await page.goto('/object-storage');
  await expect(page.locator('.storage-cards')).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search' });
  await page.getByRole('search').getByText('Search', { exact: true }).click();
  await expect(search).toBeFocused();
  const icon = page.getByRole('search').locator('svg');
  const fieldBox = (await search.boundingBox())!;
  const iconBox = (await icon.boundingBox())!;
  expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(fieldBox.x + 1);
  expect(Math.abs(iconBox.y + iconBox.height / 2 - fieldBox.y - fieldBox.height / 2)).toBeLessThanOrEqual(1);

  try {
    await search.fill('atlas-search-test');
    await expect(page.locator('.storage-panel [aria-busy="true"]')).toBeVisible();
    expect(Math.abs((await search.boundingBox())!.y - fieldBox.y)).toBeLessThanOrEqual(1);
    await expect(search).toBeFocused();
  } finally {
    finish();
  }
  await expect(page.locator('.storage-panel [aria-busy="true"]')).toHaveCount(0);
  await expect(search).toHaveValue('atlas-search-test');
});
