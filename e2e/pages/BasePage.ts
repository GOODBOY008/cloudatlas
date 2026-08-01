import { Page, Locator } from '@playwright/test';

/**
 * Base page object — provides shared helpers for all pages.
 */
export class BasePage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /** Navigate and wait for the network to settle */
  async goto(path: string): Promise<void> {
    await this.page.goto(path);
    await this.page.waitForLoadState('networkidle');
  }

  /** Wait for a visible text in the main content area */
  async waitForContent(text: string): Promise<void> {
    await this.page.locator('main').getByText(text).first().waitFor({ state: 'visible' });
  }

  /** Get the sidebar nav */
  get sidebar(): Locator {
    return this.page.locator('nav');
  }

  /** Click a sidebar nav link by display text */
  async clickNavLink(label: string): Promise<void> {
    await this.sidebar.getByRole('link', { name: label }).click();
    await this.page.waitForLoadState('networkidle');
  }

  /** Close any open modal by pressing Escape */
  async closeModal(): Promise<void> {
    await this.page.keyboard.press('Escape');
  }

  /** Check whether the current URL matches a pattern */
  currentUrl(): string {
    return this.page.url();
  }
}
