import { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

const TABS = [
  'Overview', 'By Service', 'By Region', 'By Cloud',
  'By Pool', 'Trend', 'Top Resources', 'Forecast',
  'Anomalies', 'RI Coverage', 'By Tag',
] as const;

export type ExpensesTab = (typeof TABS)[number];

export class ExpensesPage extends BasePage {
  readonly main: Locator;

  constructor(page: Page) {
    super(page);
    this.main = page.locator('main');
  }

  async navigate(): Promise<void> {
    await this.goto('/expenses');
  }

  async clickTab(tab: ExpensesTab): Promise<void> {
    await this.page.getByRole('button', { name: tab }).click();
    await this.page.waitForLoadState('networkidle');
  }

  async setDateRange(label: '7d' | '30d' | '90d' | 'MTD'): Promise<void> {
    await this.page.getByRole('button', { name: label }).click();
    await this.page.waitForLoadState('networkidle');
  }
}
