import { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class DashboardPage extends BasePage {
  readonly totalCostCard: Locator;
  readonly resourcesCard: Locator;
  readonly recommendationsCard: Locator;
  readonly poolsCard: Locator;
  readonly costTrendChart: Locator;
  readonly openExpensesBtn: Locator;
  readonly openPoolsBtn: Locator;

  constructor(page: Page) {
    super(page);
    this.totalCostCard = page.locator('main').getByText('Total Cost').first();
    this.resourcesCard = page.locator('main').getByText('Resources').first();
    this.recommendationsCard = page.locator('main').getByText('Recommendation').first();
    this.poolsCard = page.locator('main').getByText('Pool').first();
    this.costTrendChart = page.locator('main svg').first();
    this.openExpensesBtn = page.getByRole('button', { name: /open expenses/i });
    this.openPoolsBtn = page.getByRole('button', { name: /open pools/i });
  }

  async navigate(): Promise<void> {
    await this.goto('/dashboard');
  }
}
