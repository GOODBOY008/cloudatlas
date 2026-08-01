/**
 * Shared types for the CloudAtlas AI agent E2E framework.
 */

// ─── Scenario definition ────────────────────────────────────────────────────

export interface TestScenario {
  /** Unique identifier, e.g. "AUTH-01" */
  id: string;
  /** Human-readable name */
  name: string;
  /**
   * Natural language goal handed to the AI agent.
   * Be specific about what to navigate to, what to do, and what to verify.
   */
  goal: string;
  /** Tags for filtering (e.g. "smoke", "auth", "regression") */
  tags?: string[];
  /** Suite grouping (e.g. "auth", "dashboard", "finops", "cmdb") */
  suite: string;
  /** Optional setup state override — 'logged-in' (default) | 'logged-out' */
  authState?: 'logged-in' | 'logged-out';
}

// ─── Browser tool results ────────────────────────────────────────────────────

export interface PageState {
  url: string;
  title: string;
  /** Visible text on page, truncated to 3000 chars */
  content: string;
  /** Any error/alert messages visible */
  errors: string[];
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// ─── Test results ────────────────────────────────────────────────────────────

export type TestStatus = 'passed' | 'failed' | 'error' | 'skipped';

export interface StepRecord {
  tool: string;
  input: object;
  result: string;
  timestamp: number;
}

export interface TestResult {
  scenario: TestScenario;
  status: TestStatus;
  summary: string;
  failureReason?: string;
  steps: StepRecord[];
  screenshotPaths: string[];
  durationMs: number;
  /** Raw messages exchanged with the Claude API */
  agentMessages?: unknown[];
}

export interface SuiteResult {
  suiteName: string;
  results: TestResult[];
  totalMs: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
}

// ─── Agent config ────────────────────────────────────────────────────────────

export interface AgentConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  apiUrl: string;
  adminEmail: string;
  adminPass: string;
  maxSteps: number;
  headless: boolean;
  slowMo: number;
  screenshotsDir: string;
  reportsDir: string;
}

// ─── Claude tool input shapes ─────────────────────────────────────────────────

export interface NavigateInput { url: string }
export interface ClickInput { target: string; strategy?: 'text' | 'css' | 'placeholder' | 'label' | 'role' }
export interface FillInput { target: string; value: string; strategy?: 'placeholder' | 'label' | 'css' }
export interface AssertVisibleInput { text: string }
export interface AssertUrlInput { pattern: string }
export interface LocalStorageInput { key: string }
export interface SelectInput { target: string; value: string }
export interface FinishTestInput { passed: boolean; summary: string; failure_reason?: string }
