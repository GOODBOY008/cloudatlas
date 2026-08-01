/**
 * Playwright browser tools — the concrete implementation of every action
 * the AI agent can perform. Each method maps 1:1 to a Claude tool.
 *
 * The BrowserSession wraps a single Playwright page and accumulates step
 * records + screenshot paths for inclusion in the final test report.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import type {
  PageState,
  StepRecord,
  ClickInput,
  FillInput,
  NavigateInput,
  AssertVisibleInput,
  AssertUrlInput,
  LocalStorageInput,
  SelectInput,
} from './types.js';

export class BrowserSession {
  private browser!: Browser;
  private context!: BrowserContext;
  public page!: Page;

  public steps: StepRecord[] = [];
  public screenshotPaths: string[] = [];

  private screenshotsDir: string;
  private baseUrl: string;
  private screenshotCounter = 0;

  constructor(screenshotsDir: string, baseUrl: string) {
    this.screenshotsDir = screenshotsDir;
    this.baseUrl = baseUrl;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async launch(headless: boolean, slowMo: number, storageStatePath?: string): Promise<void> {
    this.browser = await chromium.launch({ headless, slowMo });
    const ctxOptions: Parameters<Browser['newContext']>[0] = {
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
    };
    if (storageStatePath && fs.existsSync(storageStatePath)) {
      ctxOptions.storageState = storageStatePath;
    }
    this.context = await this.browser.newContext(ctxOptions);
    this.page = await this.context.newPage();
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }

  async saveStorageState(filePath: string): Promise<void> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await this.context.storageState({ path: filePath });
  }

  // ─── Tools ──────────────────────────────────────────────────────────────────

  async navigate(input: NavigateInput): Promise<string> {
    const url = input.url.startsWith('http') ? input.url : `${this.baseUrl}${input.url}`;
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      this.recordStep('navigate', input, `Navigated to ${url}`);
      return `Navigated to ${url}. Current URL: ${this.page.url()}`;
    } catch (err) {
      const msg = `Navigation failed: ${(err as Error).message}`;
      this.recordStep('navigate', input, msg);
      return msg;
    }
  }

  async click(input: ClickInput): Promise<string> {
    const { target, strategy = 'text' } = input;
    try {
      const locator = this.resolveLocator(target, strategy);
      await locator.first().click({ timeout: 10_000 });
      await this.page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
      const result = `Clicked "${target}" (strategy: ${strategy}). Current URL: ${this.page.url()}`;
      this.recordStep('click', input, result);
      return result;
    } catch (err) {
      // Try fallback strategies
      const fallbacks: Array<ClickInput['strategy']> = ['css', 'placeholder', 'text'];
      for (const fb of fallbacks) {
        if (fb === strategy) continue;
        try {
          const loc = this.resolveLocator(target, fb);
          await loc.first().click({ timeout: 5_000 });
          const result = `Clicked "${target}" via fallback strategy: ${fb}. URL: ${this.page.url()}`;
          this.recordStep('click', input, result);
          return result;
        } catch {
          // continue
        }
      }
      const msg = `Click failed for "${target}": ${(err as Error).message}`;
      this.recordStep('click', input, msg);
      return msg;
    }
  }

  async fill(input: FillInput): Promise<string> {
    const { target, value, strategy = 'placeholder' } = input;
    try {
      const locator = this.resolveLocator(target, strategy);
      await locator.first().fill(value, { timeout: 10_000 });
      const result = `Filled "${target}" with "${value.length > 20 ? value.slice(0, 20) + '...' : value}"`;
      this.recordStep('fill', input, result);
      return result;
    } catch (err) {
      // Try label fallback
      try {
        await this.page.getByLabel(target).first().fill(value, { timeout: 5_000 });
        const result = `Filled by label "${target}"`;
        this.recordStep('fill', input, result);
        return result;
      } catch {
        const msg = `Fill failed for "${target}": ${(err as Error).message}`;
        this.recordStep('fill', input, msg);
        return msg;
      }
    }
  }

  async select(input: SelectInput): Promise<string> {
    const { target, value } = input;
    try {
      const locator = this.page.locator(`select:near(:text("${target}"))`).or(
        this.page.locator(`[name="${target}"]`).or(this.page.locator(`#${target}`))
      );
      await locator.first().selectOption(value, { timeout: 10_000 });
      const result = `Selected "${value}" for "${target}"`;
      this.recordStep('select', input, result);
      return result;
    } catch (err) {
      const msg = `Select failed for "${target}": ${(err as Error).message}`;
      this.recordStep('select', input, msg);
      return msg;
    }
  }

  async getPageState(): Promise<PageState> {
    const url = this.page.url();
    const title = await this.page.title();

    // Extract visible text, prefer main content areas
    let content = '';
    try {
      content = await this.page.evaluate(() => {
        const main = document.querySelector('main') ?? document.body;
        return (main.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 3000);
      });
    } catch {
      content = '(could not extract page text)';
    }

    // Collect error messages
    const errors: string[] = [];
    try {
      const errorEls = await this.page.locator('[class*="error"], [class*="alert"], [role="alert"]').allTextContents();
      errors.push(...errorEls.filter(t => t.trim().length > 0));
    } catch { /* ignore */ }

    this.recordStep('get_page_state', {}, `URL: ${url}, Title: ${title}`);
    return { url, title, content, errors };
  }

  async assertVisible(input: AssertVisibleInput): Promise<string> {
    const { text } = input;
    try {
      await this.page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 8_000 });
      const result = `✓ Text "${text}" is visible`;
      this.recordStep('assert_visible', input, result);
      return result;
    } catch {
      // Try broader: check if text exists anywhere in the DOM
      const bodyText = await this.page.evaluate(() => document.body.innerText);
      if (bodyText.toLowerCase().includes(text.toLowerCase())) {
        const result = `✓ Text "${text}" found in page (not necessarily visible)`;
        this.recordStep('assert_visible', input, result);
        return result;
      }
      const result = `✗ Text "${text}" NOT found on page`;
      this.recordStep('assert_visible', input, result);
      return result;
    }
  }

  async assertUrl(input: AssertUrlInput): Promise<string> {
    const currentUrl = this.page.url();
    const matches = currentUrl.includes(input.pattern);
    const result = matches
      ? `✓ URL "${currentUrl}" matches pattern "${input.pattern}"`
      : `✗ URL "${currentUrl}" does NOT match pattern "${input.pattern}"`;
    this.recordStep('assert_url', input, result);
    return result;
  }

  async screenshot(): Promise<{ base64: string; path: string }> {
    this.screenshotCounter++;
    fs.mkdirSync(this.screenshotsDir, { recursive: true });
    const filename = `step-${this.screenshotCounter}-${Date.now()}.png`;
    const filePath = path.join(this.screenshotsDir, filename);
    const buf = await this.page.screenshot({ path: filePath, fullPage: false });
    this.screenshotPaths.push(filePath);
    this.recordStep('screenshot', {}, `Screenshot saved: ${filename}`);
    return { base64: buf.toString('base64'), path: filePath };
  }

  async getLocalStorage(input: LocalStorageInput): Promise<string> {
    try {
      const value = await this.page.evaluate((k: string) => localStorage.getItem(k), input.key);
      const result = value !== null
        ? `localStorage["${input.key}"] = "${value.slice(0, 100)}"`
        : `localStorage["${input.key}"] is null (not set)`;
      this.recordStep('get_local_storage', input, result);
      return result;
    } catch (err) {
      const msg = `localStorage access failed: ${(err as Error).message}`;
      this.recordStep('get_local_storage', input, msg);
      return msg;
    }
  }

  async clearLocalStorage(): Promise<string> {
    try {
      await this.page.evaluate(() => localStorage.clear());
      this.recordStep('clear_local_storage', {}, 'localStorage cleared');
      return 'localStorage cleared';
    } catch (err) {
      return `Failed to clear localStorage: ${(err as Error).message}`;
    }
  }

  async waitForSelector(selector: string): Promise<string> {
    try {
      await this.page.locator(selector).first().waitFor({ state: 'visible', timeout: 10_000 });
      return `Element "${selector}" is visible`;
    } catch {
      return `Element "${selector}" not found within timeout`;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private resolveLocator(target: string, strategy: ClickInput['strategy']) {
    switch (strategy) {
      case 'css':
        return this.page.locator(target);
      case 'placeholder':
        return this.page.getByPlaceholder(target, { exact: false });
      case 'label':
        return this.page.getByLabel(target, { exact: false });
      case 'role':
        // Parse "button:Sign In" format
        if (target.includes(':')) {
          const [role, name] = target.split(':') as [string, string];
          return this.page.getByRole(role as Parameters<Page['getByRole']>[0], { name });
        }
        return this.page.getByRole(target as Parameters<Page['getByRole']>[0]);
      case 'text':
      default:
        return this.page.getByText(target, { exact: false });
    }
  }

  private recordStep(tool: string, input: object, result: string): void {
    this.steps.push({ tool, input, result, timestamp: Date.now() });
  }
}
