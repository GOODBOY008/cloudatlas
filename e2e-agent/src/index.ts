#!/usr/bin/env node
/**
 * CloudAtlas AI Agent E2E — CLI Entry Point
 *
 * Usage:
 *   npx tsx src/index.ts [options]
 *
 * Options:
 *   --suite <name>     Run scenarios in a specific suite (auth|dashboard|finops|cmdb|navigation)
 *   --tags <list>      Run scenarios matching tags, comma-separated (e.g. "smoke")
 *   --ids <list>       Run specific scenario IDs, comma-separated (e.g. "AUTH-01,CMDB-03")
 *   --headed           Run browser in headed (visible) mode
 *   --slow-mo <ms>     Add delay between actions (ms, default 0)
 *   --concurrency <n>  Max parallel scenarios (default 1)
 *   --list             List all scenarios and exit
 *   --help             Show usage
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { AITestAgent } from './agent.js';
import { BrowserSession } from './browser.js';
import { generateReport, printSummary } from './reporter.js';
import { ALL_SCENARIOS, filterScenarios } from './scenarios/index.js';
import type { AgentConfig, TestResult, TestScenario } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ─── Load .env if present ────────────────────────────────────────────────────

function loadDotEnv(): void {
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) return;
  const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

// ─── Parse args ──────────────────────────────────────────────────────────────

function parseArgs(): {
  suite?: string;
  tags?: string;
  ids?: string;
  headed: boolean;
  slowMo: number;
  concurrency: number;
  list: boolean;
  help: boolean;
} {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (flag: string) => args.includes(flag);

  return {
    suite: get('--suite'),
    tags: get('--tags'),
    ids: get('--ids'),
    headed: has('--headed') || has('--no-headless'),
    slowMo: parseInt(get('--slow-mo') ?? '0', 10) || 0,
    concurrency: parseInt(get('--concurrency') ?? '1', 10) || 1,
    list: has('--list'),
    help: has('--help') || has('-h'),
  };
}

// ─── Pre-authentication ───────────────────────────────────────────────────────

async function authenticate(config: AgentConfig): Promise<string> {
  const authDir = path.join(ROOT, '.auth');
  const authFile = path.join(authDir, 'user.json');
  fs.mkdirSync(authDir, { recursive: true });

  console.log('  🔐 Pre-authenticating as', config.adminEmail, '...');
  const session = new BrowserSession(config.screenshotsDir, config.baseUrl);
  await session.launch(config.headless, 0);

  try {
    await session.navigate({ url: '/login' });
    await session.fill({ target: 'email', value: config.adminEmail, strategy: 'placeholder' });
    await session.fill({ target: 'password', value: config.adminPass, strategy: 'placeholder' });
    await session.click({ target: 'Sign In', strategy: 'text' });

    // Wait for redirect to dashboard
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      const url = session.page.url();
      if (url.includes('dashboard') || url.includes('/dashboard')) break;
    }

    const url = session.page.url();
    if (!url.includes('dashboard')) {
      throw new Error(`Login redirect failed — still on: ${url}`);
    }

    const token = await session.page.evaluate(() => localStorage.getItem('ca_access_token'));
    if (!token) throw new Error('No ca_access_token in localStorage after login');

    await session.saveStorageState(authFile);
    console.log('  ✓ Auth state saved to', path.relative(ROOT, authFile));
    return authFile;
  } finally {
    await session.close();
  }
}

// ─── Run scenarios (with optional parallelism) ───────────────────────────────

async function runScenarios(
  scenarios: TestScenario[],
  agent: AITestAgent,
  authStatePath: string,
  concurrency: number,
): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // Split into chunks for limited parallelism
  for (let i = 0; i < scenarios.length; i += concurrency) {
    const batch = scenarios.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async scenario => {
        console.log(`\n▶ [${scenario.id}] ${scenario.name}`);
        const result = await agent.runScenario(scenario, authStatePath);
        const icon = result.status === 'passed' ? '✓' : result.status === 'failed' ? '✗' : '⚠';
        console.log(`  ${icon} [${scenario.id}] ${result.status.toUpperCase()} — ${result.summary.slice(0, 100)}`);
        return result;
      }),
    );
    results.push(...batchResults);
  }

  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadDotEnv();
  const args = parseArgs();

  if (args.help) {
    console.log(`
CloudAtlas AI Agent E2E

Usage:
  npx tsx src/index.ts [options]

Options:
  --suite <name>       Run specific suite: auth | dashboard | finops | cmdb | navigation
  --tags <list>        Filter by tags (e.g. --tags smoke)
  --ids <list>         Run specific IDs (e.g. --ids AUTH-01,CMDB-03)
  --headed             Run browser visibly (default: headless)
  --slow-mo <ms>       Slow down actions by <ms> milliseconds
  --concurrency <n>    Parallel scenarios (default: 1, max recommended: 3)
  --list               List all scenarios and exit
  --help               Show this help

Environment variables (can also use .env file):
  ANTHROPIC_API_KEY    Required — your Anthropic API key
  AGENT_MODEL          Claude model (default: claude-3-5-sonnet-20241022)
  AGENT_BASE_URL       Frontend URL (default: http://localhost:5173)
  AGENT_ADMIN_EMAIL    Admin email (default: admin@acme.com)
  AGENT_ADMIN_PASS     Admin password (default: Password123!)
  AGENT_MAX_STEPS      Max tool calls per scenario (default: 40)
  AGENT_HEADLESS       Set to "false" to run headed

Examples:
  npx tsx src/index.ts --tags smoke
  npx tsx src/index.ts --suite auth --headed
  npx tsx src/index.ts --ids AUTH-01,DASH-01 --slow-mo 500
  npx tsx src/index.ts --suite finops --concurrency 2
`);
    process.exit(0);
  }

  if (args.list) {
    const scenarios = filterScenarios({ suite: args.suite, tags: args.tags, ids: args.ids });
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  CloudAtlas AI Agent E2E — ${scenarios.length} scenarios`);
    console.log('─'.repeat(60));
    let currentSuite = '';
    for (const s of scenarios) {
      if (s.suite !== currentSuite) {
        console.log(`\n  [${s.suite.toUpperCase()}]`);
        currentSuite = s.suite;
      }
      const tags = s.tags?.join(', ') ?? '';
      console.log(`    ${s.id.padEnd(10)} ${s.name.padEnd(45)} ${tags}`);
    }
    console.log('');
    process.exit(0);
  }

  // ── Validate API key ──────────────────────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.startsWith('sk-ant-...')) {
    console.error('❌ Error: ANTHROPIC_API_KEY is not set.');
    console.error('   Copy .env.example to .env and add your Anthropic API key.');
    console.error('   Get a key at: https://console.anthropic.com/settings/keys');
    process.exit(1);
  }

  // ── Build config ──────────────────────────────────────────────────────────
  const reportsDir = path.join(ROOT, 'reports');
  const screenshotsDir = path.join(ROOT, 'screenshots');

  const config: AgentConfig = {
    apiKey,
    model: process.env.AGENT_MODEL ?? 'claude-3-5-sonnet-20241022',
    baseUrl: process.env.AGENT_BASE_URL ?? 'http://localhost:5173',
    apiUrl: process.env.AGENT_API_URL ?? 'http://localhost:8080',
    adminEmail: process.env.AGENT_ADMIN_EMAIL ?? 'admin@acme.com',
    adminPass: process.env.AGENT_ADMIN_PASS ?? 'Password123!',
    maxSteps: parseInt(process.env.AGENT_MAX_STEPS ?? '40', 10),
    headless: args.headed ? false : (process.env.AGENT_HEADLESS !== 'false'),
    slowMo: args.slowMo,
    screenshotsDir,
    reportsDir,
  };

  // ── Select scenarios ──────────────────────────────────────────────────────
  const scenarios = filterScenarios({ suite: args.suite, tags: args.tags, ids: args.ids });

  if (scenarios.length === 0) {
    console.error('❌ No scenarios matched the given filters.');
    console.error('   Run with --list to see available scenarios.');
    process.exit(1);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  CloudAtlas AI Agent E2E');
  console.log('═'.repeat(60));
  console.log(`  Scenarios: ${scenarios.length}`);
  console.log(`  Model:     ${config.model}`);
  console.log(`  App URL:   ${config.baseUrl}`);
  console.log(`  Headless:  ${config.headless}`);
  if (args.concurrency > 1) console.log(`  Parallel:  ${args.concurrency}`);
  console.log('═'.repeat(60) + '\n');

  // ── Pre-authenticate ──────────────────────────────────────────────────────
  let authStatePath: string;
  try {
    authStatePath = await authenticate(config);
  } catch (err) {
    console.error(`❌ Pre-authentication failed: ${(err as Error).message}`);
    console.error('   Make sure the CloudAtlas frontend is running at', config.baseUrl);
    process.exit(1);
  }

  // ── Run tests ─────────────────────────────────────────────────────────────
  const agent = new AITestAgent(config);
  const results = await runScenarios(scenarios, agent, authStatePath, args.concurrency);

  // ── Report ────────────────────────────────────────────────────────────────
  printSummary(results);
  const { htmlPath, jsonPath } = generateReport(results, reportsDir, screenshotsDir);
  console.log(`  HTML report: ${path.relative(process.cwd(), htmlPath)}`);
  console.log(`  JSON report: ${path.relative(process.cwd(), jsonPath)}\n`);

  // Exit with non-zero if any test failed
  const anyFailed = results.some(r => r.status === 'failed' || r.status === 'error');
  process.exit(anyFailed ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
