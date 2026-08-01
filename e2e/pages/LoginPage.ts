import { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class LoginPage extends BasePage {
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly signInButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    super(page);
    this.emailInput = page
      .locator('input[type="text"], input[type="email"], input[placeholder*="email" i]')
      .first();
    this.passwordInput = page.locator('input[type="password"]').first();
    this.signInButton = page.getByRole('button', { name: /sign in/i });
    this.errorMessage = page.locator('[role="alert"], .error, [class*="error"]').first();
  }

  async navigate(): Promise<void> {
    await this.goto('/login');
  }

  async login(email: string, password: string): Promise<void> {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.signInButton.click();
  }

  async isVisible(): Promise<boolean> {
    return this.signInButton.isVisible();
  }
}
