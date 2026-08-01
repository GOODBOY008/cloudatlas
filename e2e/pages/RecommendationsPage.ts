import { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class RecommendationsPage extends BasePage {
  readonly main: Locator;
  readonly searchInput: Locator;

  constructor(page: Page) {
    super(page);
    this.main = page.locator('main');
    this.searchInput = page.getByPlaceholder(/search/i).first();
  }

  async navigate(): Promise<void> {
    await this.goto('/recommendations');
  }

  async clickCategory(category: string): Promise<void> {
    await this.page.getByRole('button', { name: category }).click();
    await this.page.waitForLoadState('networkidle');
  }

  async search(query: string): Promise<void> {
    await this.searchInput.fill(query);
    await this.page.waitForLoadState('networkidle');
  }
}
