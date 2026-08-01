import { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class CloudAccountsPage extends BasePage {
  readonly addAccountBtn: Locator;
  readonly accountList: Locator;

  constructor(page: Page) {
    super(page);
    this.addAccountBtn = page.getByRole('button', { name: /add account/i });
    this.accountList = page.locator('main table, main ul').first();
  }

  async navigate(): Promise<void> {
    await this.goto('/cloud-accounts');
  }

  async openAddForm(): Promise<void> {
    await this.addAccountBtn.click();
  }

  async addAccount(name: string, provider: string, externalId: string): Promise<void> {
    await this.openAddForm();
    await this.page.getByLabel(/account name/i).fill(name);
    const providerSelect = this.page.getByLabel(/provider/i);
    if (await providerSelect.isVisible()) await providerSelect.selectOption(provider);
    await this.page.getByLabel(/external id/i).fill(externalId);
    await this.page.locator('form').getByRole('button', { name: /add account/i }).click();
  }

  async addAccountWithCredentials(
    name: string,
    provider: string,
    externalId: string,
    creds: Record<string, string>,
  ): Promise<void> {
    await this.openAddForm();
    await this.page.getByLabel(/account name/i).fill(name);
    const providerSelect = this.page.getByLabel(/provider/i);
    if (await providerSelect.isVisible()) await providerSelect.selectOption(provider);
    await this.page.getByLabel(/external id/i).fill(externalId);
    for (const [key, value] of Object.entries(creds)) {
      await this.page.locator(`#cred-${key}`).fill(value);
    }
    await this.page.locator('form').getByRole('button', { name: /add account/i }).click();
  }

  async openEdit(name: string): Promise<void> {
    await this.page
      .locator('main table tr', { hasText: name })
      .getByRole('button', { name: /edit/i })
      .click();
  }

  async saveEdit(): Promise<void> {
    await this.page.locator('form').getByRole('button', { name: /save/i }).click();
  }
}
