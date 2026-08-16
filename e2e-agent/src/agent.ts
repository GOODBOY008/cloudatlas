/**
 * AI Agent — the core Claude tool-calling loop.
 *
 * The agent receives a test scenario (natural language goal) and autonomously:
 *   1. Decides which browser tool to call next
 *   2. Executes the tool via BrowserSession
 *   3. Feeds the result back to Claude
 *   4. Repeats until finish_test is called or max steps exceeded
 *
 * Screenshots are returned as image content blocks so Claude can visually
 * inspect the page state (requires a vision-capable model).
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  ContentBlock,
  ToolUseBlock,
  TextBlock,
} from '@anthropic-ai/sdk/resources/messages.js';
import { BrowserSession } from './browser.js';
import { BROWSER_TOOLS } from './tools.js';
import type {
  TestScenario,
  TestResult,
  AgentConfig,
  FinishTestInput,
} from './types.js';

// ─── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert QA engineer and E2E test agent for CloudAtlas,
a unified FinOps + CMDB platform built with React (frontend) and Rust/Axum (backend).

## App context
- Frontend: React + TypeScript + TailwindCSS (dark theme by default)
- Auth: JWT stored in localStorage as "ca_access_token"
- Default admin: admin@acme.com / Password123!
- Base URL: {BASE_URL}

## Your task
Execute the given test scenario by using the browser tools provided.
Be methodical:
1. Call get_page_state first to understand the current page
2. Take a screenshot when you need to visually verify something
3. Use assert_visible and assert_url to record evidence
4. Navigate, click, fill forms as needed to achieve the test goal
5. When you have conclusive evidence of pass or fail, call finish_test

## Rules
- Never guess — verify with tools before concluding
- If a navigation fails, try once more then report failure
- If an element is not found, take a screenshot and describe what you see
- Be concise in finish_test.summary (1-3 sentences)
- Do NOT call finish_test until you have sufficient evidence`;

// ─── Agent ───────────────────────────────────────────────────────────────────

export class AITestAgent {
  private client: Anthropic;
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
    this.client = new Anthropic({ apiKey: config.apiKey });
  }

  /**
   * Run a single test scenario in a fresh browser session.
   * Returns a fully populated TestResult.
   */
  async runScenario(scenario: TestScenario, authStatePath?: string): Promise<TestResult> {
    const startMs = Date.now();
    const scenarioScreenshotsDir = `${this.config.screenshotsDir}/${scenario.id}`;

    const browser = new BrowserSession(scenarioScreenshotsDir, this.config.baseUrl);

    try {
      // Launch browser; reuse auth state for logged-in scenarios
      const loadAuthState =
        scenario.authState !== 'logged-out' && authStatePath ? authStatePath : undefined;
      await browser.launch(this.config.headless, this.config.slowMo, loadAuthState);

      const result = await this.agentLoop(scenario, browser);
      return {
        ...result,
        steps: browser.steps,
        screenshotPaths: browser.screenshotPaths,
        durationMs: Date.now() - startMs,
      };
    } catch (err) {
      return {
        scenario,
        status: 'error',
        summary: `Agent error: ${(err as Error).message}`,
        steps: browser.steps,
        screenshotPaths: browser.screenshotPaths,
        durationMs: Date.now() - startMs,
      };
    } finally {
      await browser.close();
    }
  }

  // ─── Internal: agent loop ──────────────────────────────────────────────────

  private async agentLoop(
    scenario: TestScenario,
    browser: BrowserSession,
  ): Promise<Omit<TestResult, 'steps' | 'screenshotPaths' | 'durationMs'>> {
    const systemPrompt = SYSTEM_PROMPT.replace('{BASE_URL}', this.config.baseUrl);

    const initialUserMessage =
      `Test Scenario: ${scenario.name}\n` +
      `ID: ${scenario.id}\n\n` +
      `Goal:\n${scenario.goal}\n\n` +
      `Admin credentials: ${this.config.adminEmail} / ${this.config.adminPass}\n` +
      `Start by calling get_page_state to see the current state, then proceed.`;

    const messages: MessageParam[] = [
      { role: 'user', content: initialUserMessage },
    ];

    let finishInput: FinishTestInput | null = null;
    let step = 0;

    while (step < this.config.maxSteps) {
      step++;

      let response: Anthropic.Message;
      try {
        response = await this.client.messages.create({
          model: this.config.model,
          max_tokens: 4096,
          system: systemPrompt,
          tools: BROWSER_TOOLS,
          messages,
        });
      } catch (err) {
        const msg = `Anthropic API error: ${(err as Error).message}`;
        console.error(`  [agent] ${msg}`);
        return { scenario, status: 'error', summary: msg };
      }

      // Add the assistant's response to the conversation
      messages.push({ role: 'assistant', content: response.content });

      // Check for end_turn (no more tool calls)
      if (response.stop_reason === 'end_turn') {
        // Extract any final text as summary
        const textBlock = response.content.find((b): b is TextBlock => b.type === 'text');
        return {
          scenario,
          status: 'error',
          summary: textBlock?.text ?? 'Agent stopped without calling finish_test',
        };
      }

      // Process all tool_use blocks
      const toolUseBlocks = response.content.filter(
        (b): b is ToolUseBlock => b.type === 'tool_use',
      );

      if (toolUseBlocks.length === 0) break;

      // Build tool_result blocks for all tool calls
      const toolResultContent: Anthropic.ToolResultBlockParam[] = [];

      for (const toolCall of toolUseBlocks) {
        const toolInput = toolCall.input as Record<string, unknown>;
        console.log(`  [${scenario.id}] step ${step}: ${toolCall.name}(${JSON.stringify(toolInput).slice(0, 80)})`);

        if (toolCall.name === 'finish_test') {
          finishInput = toolCall.input as FinishTestInput;
          toolResultContent.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: 'Test marked as complete.',
          });
          break;
        }

        const result = await this.executeTool(toolCall.name, toolInput, browser);
        // Merge the real tool_use_id before pushing
        toolResultContent.push({ ...result.block, tool_use_id: toolCall.id });

        // Log assertion outcomes prominently
        if (toolCall.name.startsWith('assert_')) {
          const passed = result.text.startsWith('✓');
          console.log(`  [${scenario.id}] ${passed ? '✓' : '✗'} ${result.text}`);
        }
      }

      // If finish_test was called, we're done
      if (finishInput) break;

      // Feed tool results back to Claude
      messages.push({ role: 'user', content: toolResultContent });
    }

    if (!finishInput) {
      return {
        scenario,
        status: 'error',
        summary: `Agent exceeded max steps (${this.config.maxSteps}) without finishing`,
      };
    }

    return {
      scenario,
      status: finishInput.passed ? 'passed' : 'failed',
      summary: finishInput.summary,
      failureReason: finishInput.failure_reason,
      agentMessages: messages,
    };
  }

  // ─── Tool dispatcher ───────────────────────────────────────────────────────

  private async executeTool(
    name: string,
    input: Record<string, unknown>,
    browser: BrowserSession,
  ): Promise<{ block: Anthropic.ToolResultBlockParam; text: string }> {
    let text = '';
    let content: Anthropic.ToolResultBlockParam['content'] = '';

    // Helper to safely cast tool input (comes from Claude as Record<string, unknown>)
    const cast = <T>(v: unknown): T => v as T;

    try {
      switch (name) {
        case 'navigate':
          text = await browser.navigate(cast<Parameters<BrowserSession['navigate']>[0]>(input));
          content = text;
          break;

        case 'click':
          text = await browser.click(cast<Parameters<BrowserSession['click']>[0]>(input));
          content = text;
          break;

        case 'fill':
          text = await browser.fill(cast<Parameters<BrowserSession['fill']>[0]>(input));
          content = text;
          break;

        case 'select':
          text = await browser.select(cast<Parameters<BrowserSession['select']>[0]>(input));
          content = text;
          break;

        case 'get_page_state': {
          const state = await browser.getPageState();
          text = `URL: ${state.url}\nTitle: ${state.title}\nContent:\n${state.content}`;
          if (state.errors.length > 0) {
            text += `\n\nERRORS/ALERTS on page:\n${state.errors.join('\n')}`;
          }
          content = text;
          break;
        }

        case 'assert_visible':
          text = await browser.assertVisible(
            cast<Parameters<BrowserSession['assertVisible']>[0]>(input),
          );
          content = text;
          break;

        case 'assert_url':
          text = await browser.assertUrl(
            cast<Parameters<BrowserSession['assertUrl']>[0]>(input),
          );
          content = text;
          break;

        case 'screenshot': {
          const { base64, path: p } = await browser.screenshot();
          text = `Screenshot captured: ${p}`;
          // Text-only model backends (e.g. OpenAI-compatible providers without
          // vision) reject image blocks; AGENT_SEND_IMAGES=false keeps the PNG
          // on disk for the report but describes it instead of attaching it.
          if ((process.env.AGENT_SEND_IMAGES ?? 'true').toLowerCase() === 'false') {
            content = `${text} (image not sent to model: AGENT_SEND_IMAGES=false). Current URL: ${browser.page.url()}`;
            break;
          }
          // Return screenshot as image content block — lets Claude see the page
          content = [
            {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: 'image/png' as const,
                data: base64,
              },
            },
            { type: 'text' as const, text: `Current URL: ${browser.page.url()}` },
          ];
          break;
        }

        case 'get_local_storage':
          text = await browser.getLocalStorage(
            cast<Parameters<BrowserSession['getLocalStorage']>[0]>(input),
          );
          content = text;
          break;

        case 'clear_local_storage':
          text = await browser.clearLocalStorage();
          content = text;
          break;

        default:
          text = `Unknown tool: ${name}`;
          content = text;
      }
    } catch (err) {
      text = `Tool execution error (${name}): ${(err as Error).message}`;
      content = text;
    }

    return {
      text,
      block: {
        type: 'tool_result' as const,
        tool_use_id: 'placeholder', // caller overwrites with real toolCall.id
        content,
      },
    };
  }
}

// tool_use_id is overwritten by the caller via spread: { ...result.block, tool_use_id: toolCall.id }
