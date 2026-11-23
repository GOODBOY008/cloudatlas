import { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class PoolsPage extends BasePage {
  readonly newPoolBtn: Locator;
  readonly poolList: Locator;
  readonly formHeading: Locator;
  readonly nameInput: Locator;
  readonly typeSelect: Locator;
  readonly parentSelect: Locator;
  readonly descriptionInput: Locator;
  readonly budgetInput: Locator;
  readonly createPoolBtn: Locator;
  readonly deleteDialog: Locator;

  constructor(page: Page) {
    super(page);
    this.newPoolBtn = page.getByRole('button', { name: /new pool/i });
    this.poolList = page.locator('main');
    this.formHeading = page.getByRole('heading', { name: /new pool|edit pool/i });
    // Form fields have no labels — use placeholder or positional selectors
    this.nameInput = page.getByRole('textbox').first();
    this.typeSelect = page.locator('select').first();
    this.parentSelect = page.locator('select').nth(1);
    this.descriptionInput = page.getByPlaceholder(/cloud spend|description/i);
    this.budgetInput = page.getByRole('spinbutton');
    this.createPoolBtn = page.getByRole('button', { name: /create pool/i });
    this.deleteDialog = page.getByRole('dialog', { name: 'Delete pool?', exact: true });
  }

  async navigate(): Promise<void> {
    await this.goto('/pools');
  }

  async openCreateModal(): Promise<void> {
    await this.newPoolBtn.click();
    await this.formHeading.waitFor({ state: 'visible' });
  }

  async createPool(name: string, type = 'project'): Promise<void> {
    await this.openCreateModal();
    await this.nameInput.fill(name);
    if (await this.typeSelect.isVisible()) await this.typeSelect.selectOption(type);
    await this.createPoolBtn.click();
    await this.formHeading.waitFor({ state: 'hidden', timeout: 10_000 });
  }

  async openDeleteDialog(name: string): Promise<void> {
    const row = this.poolList.getByRole('listitem').filter({ has: this.page.getByText(name, { exact: true }) });
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    await this.deleteDialog.waitFor({ state: 'visible' });
  }
}
