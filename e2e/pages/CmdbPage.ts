import { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class CmdbPage extends BasePage {
  readonly newCiBtn: Locator;
  readonly searchInput: Locator;
  readonly ciTable: Locator;
  readonly formHeading: Locator;
  readonly nameInput: Locator;
  readonly displayNameInput: Locator;
  readonly ciTypeSelect: Locator;
  readonly providerSelect: Locator;
  readonly regionInput: Locator;
  readonly createCiBtn: Locator;
  readonly firstCiRow: Locator;
  readonly tagsEditBtn: Locator;
  readonly tagsEditor: Locator;
  readonly tagsSaveBtn: Locator;
  readonly tagsError: Locator;
  readonly drawer: Locator;

  constructor(page: Page) {
    super(page);
    this.newCiBtn = page.getByRole('button', { name: /new ci/i });
    this.searchInput = page.getByPlaceholder(/search/i).first();
    this.ciTable = page.locator('main table').first();
    this.formHeading = page.getByRole('heading', { name: /new configuration item/i });
    // Form fields have no labels — use positional selectors (form appears before table in DOM)
    this.nameInput = page.getByRole('textbox').first();
    this.displayNameInput = page.getByRole('textbox').nth(1);
    this.ciTypeSelect = page.locator('select').first();
    this.providerSelect = page.locator('select').nth(1);
    this.regionInput = page.getByPlaceholder(/us-east|region/i);
    this.createCiBtn = page.getByRole('button', { name: /create ci/i });
    this.firstCiRow = page.locator('main table tbody tr').first();
    // Drawer panel: the CIDrawer uses a fixed right-side panel
    this.drawer = page.locator('main aside, [class*="fixed"][class*="right-0"]').first();
    this.tagsEditBtn = page.getByTestId('ci-tags-edit');
    this.tagsEditor = page.getByTestId('ci-tags-editor');
    this.tagsSaveBtn = page.getByTestId('ci-tags-save');
    this.tagsError = page.getByTestId('ci-tags-error');
  }

  async navigate(): Promise<void> {
    await this.goto('/cmdb');
  }

  async openCreateModal(): Promise<void> {
    await this.newCiBtn.click();
    await this.formHeading.waitFor({ state: 'visible' });
  }

  async createCi(name: string, ciType: string): Promise<void> {
    await this.openCreateModal();
    await this.nameInput.fill(name);
    await this.ciTypeSelect.selectOption(ciType);
    await this.createCiBtn.click();
    await this.formHeading.waitFor({ state: 'hidden', timeout: 10_000 });
  }

  async search(query: string): Promise<void> {
    await this.searchInput.fill(query);
    await this.page.waitForTimeout(1000);
  }

  async openFirstCiDrawer(): Promise<void> {
    await this.firstCiRow.click();
    await this.tagsEditBtn.waitFor({ state: 'visible', timeout: 10_000 });
  }

  async startTagEdit(): Promise<void> {
    await this.tagsEditBtn.click();
    await this.tagsEditor.waitFor({ state: 'visible', timeout: 5_000 });
  }

  /** Replace the current tag rows with a single row containing key/value. */
  async setSingleTag(key: string, value: string): Promise<void> {
    // Remove all existing rows except the first, then set the first.
    const removeButtons = this.tagsEditor.getByRole('button', { name: /^Remove tag/ });
    const count = await removeButtons.count();
    // Keep one row; remove the rest.
    for (let i = count - 1; i >= 1; i--) {
      await removeButtons.nth(i).click();
    }
    const keyInput = this.tagsEditor.getByLabel(/^Tag 1 key$/);
    const valueInput = this.tagsEditor.getByLabel(/^Tag 1 value$/);
    await keyInput.fill(key);
    await valueInput.fill(value);
  }

  async addEmptyTagRow(): Promise<void> {
    await this.page.getByRole('button', { name: /Add tag/ }).click();
  }

  async saveTags(): Promise<void> {
    await this.tagsSaveBtn.click();
    await this.tagsSaveBtn.waitFor({ state: 'hidden', timeout: 10_000 });
  }

  async closeDrawer(): Promise<void> {
    const closeBtn = this.drawer.getByRole('button', { name: /close|✕/i }).first();
    await closeBtn.click();
  }
}
