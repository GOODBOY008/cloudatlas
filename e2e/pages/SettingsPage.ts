import { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class SettingsPage extends BasePage {
  readonly orgNameInput: Locator;
  readonly memberTable: Locator;
  readonly saveBtn: Locator;

  constructor(page: Page) {
    super(page);
    this.orgNameInput = page.getByLabel(/org(anization)? name/i).first();
    this.memberTable = page.locator('main table').first();
    this.saveBtn = page.getByRole('button', { name: /save/i }).first();
  }

  async navigate(): Promise<void> {
    await this.goto('/settings');
  }
}
