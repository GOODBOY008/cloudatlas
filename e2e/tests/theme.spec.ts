import { test, expect } from '@playwright/test';

test.describe('Workspace design and accessibility', () => {
  test('theme changes persist across routes and reloads without the Tailwind CDN', async ({ page }) => {
    const cdnRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('cdn.tailwindcss.com')) cdnRequests.push(request.url());
    });
    await page.goto('/dashboard');
    await page.evaluate(() => localStorage.removeItem('cloudatlas-theme'));
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Workspace overview' })).toBeVisible();
    const light = await page.locator('.app-shell').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(light).not.toBe('rgba(0, 0, 0, 0)');
    await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
    await expect(page.locator('html')).toHaveClass('dark');
    const dark = await page.locator('.app-shell').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(dark).not.toBe(light);
    await page.getByRole('button', { name: 'Explore costs' }).click();
    await expect(page).toHaveURL(/\/expenses$/);
    await page.reload();
    await expect(page.locator('html')).toHaveClass('dark');
    await expect(page.locator('.app-shell')).toHaveCSS('background-color', dark);
    expect(cdnRequests).toEqual([]);
  });

  test('visible search and its keyboard shortcut contain and restore focus', async ({ page }) => {
    await page.goto('/dashboard');
    const trigger = page.getByRole('button', { name: 'Search', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Search', exact: true });
    const input = dialog.getByRole('textbox', { name: 'Search', exact: true });
    await expect(input).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Close search' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(input).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Control+k');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('collapsed navigation remains reachable on mobile and closes on navigation or resize', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/dashboard');
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    await menu.click();
    const drawer = page.getByRole('dialog', { name: 'Primary navigation' });
    await expect(drawer.getByRole('button', { name: 'Close navigation' })).toBeFocused();
    await drawer.getByRole('button', { name: 'Resource Management', exact: true }).click();
    await drawer.getByRole('link', { name: 'Pools', exact: true }).click();
    await expect(page).toHaveURL(/\/pools$/);
    await expect(drawer).toBeHidden();
    await menu.click();
    await page.keyboard.press('Escape');
    await expect(menu).toBeFocused();
    await menu.click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(drawer).toBeHidden();
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Pools', exact: true })).toHaveAttribute('aria-current', 'page');
  });

  test('Chinese labels and dashboard layout fit a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'Switch language (EN / 中文)' }).click();
    await expect(page.getByRole('heading', { name: '工作空间概览' })).toBeVisible();
    await expect(page.getByRole('button', { name: '探索成本' })).toBeVisible();
    const sizes = await page.locator('main').evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    expect(sizes.scroll).toBeLessThanOrEqual(sizes.width + 1);
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
});
