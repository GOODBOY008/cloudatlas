/**
 * Claude tool definitions — describes every browser action the AI agent
 * can invoke. These are sent verbatim to the Anthropic Messages API.
 *
 * Each tool maps 1:1 to a method on BrowserSession.
 */

import type Anthropic from '@anthropic-ai/sdk';

export type ToolDefinition = Anthropic.Tool;

export const BROWSER_TOOLS: ToolDefinition[] = [
  {
    name: 'navigate',
    description:
      'Navigate the browser to a URL. Use relative paths like /dashboard or /login, or full URLs. ' +
      'Always call get_page_state after navigating to verify the page loaded correctly.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'URL or path to navigate to (e.g. "/login", "/pools", "http://localhost:5173/dashboard")',
        },
      },
      required: ['url'],
    },
  },

  {
    name: 'click',
    description:
      'Click an element on the page. Default strategy is "text" (find by visible text content). ' +
      'Use "css" for CSS selectors, "placeholder" for input placeholders, "label" for form labels.',
    input_schema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Visible text, CSS selector, placeholder text, or aria label to click',
        },
        strategy: {
          type: 'string',
          enum: ['text', 'css', 'placeholder', 'label', 'role'],
          description: 'How to locate the element. Default: "text"',
        },
      },
      required: ['target'],
    },
  },

  {
    name: 'fill',
    description:
      'Fill a text input or textarea. Locate by placeholder text (default), label text, or CSS selector. ' +
      'For email fields use placeholder "email" or label "Email". For password use placeholder "password".',
    input_schema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Placeholder text, label text, or CSS selector of the input field',
        },
        value: {
          type: 'string',
          description: 'Text to type into the field',
        },
        strategy: {
          type: 'string',
          enum: ['placeholder', 'label', 'css'],
          description: 'How to locate the input. Default: "placeholder"',
        },
      },
      required: ['target', 'value'],
    },
  },

  {
    name: 'select',
    description: 'Select an option from a <select> dropdown element.',
    input_schema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Label text or name attribute of the select element',
        },
        value: {
          type: 'string',
          description: 'Option value or visible text to select',
        },
      },
      required: ['target', 'value'],
    },
  },

  {
    name: 'get_page_state',
    description:
      'Get the current page URL, title, and visible text content (up to 3000 chars). ' +
      'Also returns any error messages visible on page. ' +
      'Use this to verify navigation succeeded and to understand what is on the page.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },

  {
    name: 'assert_visible',
    description:
      'Assert that a specific text string is visible on the page. ' +
      'Returns "✓ Text X is visible" on success or "✗ Text X NOT found" on failure. ' +
      'Use this to verify expected content, headings, labels, or messages.',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description: 'Text that should be visible on the current page',
        },
      },
      required: ['text'],
    },
  },

  {
    name: 'assert_url',
    description:
      'Assert that the current URL contains a pattern. ' +
      'Returns "✓ URL matches" or "✗ URL does NOT match". ' +
      'Use after navigation to verify correct redirect occurred.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'Substring that must appear in the current URL (e.g. "/dashboard", "/pools")',
        },
      },
      required: ['pattern'],
    },
  },

  {
    name: 'screenshot',
    description:
      'Take a screenshot of the current page for visual verification. ' +
      'Returns the screenshot as an image so you can inspect it visually. ' +
      'Use when you need to verify layout, charts, modals, or visual states.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },

  {
    name: 'get_local_storage',
    description: 'Get a value from browser localStorage. Use to verify tokens are stored after login.',
    input_schema: {
      type: 'object' as const,
      properties: {
        key: {
          type: 'string',
          description: 'Key to retrieve from localStorage (e.g. "ca_access_token")',
        },
      },
      required: ['key'],
    },
  },

  {
    name: 'clear_local_storage',
    description:
      'Clear all browser localStorage. Use before testing protected-route redirects ' +
      'to simulate a logged-out state.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },

  {
    name: 'finish_test',
    description:
      'Mark the test scenario as complete. Call this when you have sufficient evidence ' +
      'to determine pass or fail. Include a concise summary of what you verified.',
    input_schema: {
      type: 'object' as const,
      properties: {
        passed: {
          type: 'boolean',
          description: 'true if all test goals were achieved, false if any assertion failed',
        },
        summary: {
          type: 'string',
          description: 'Concise summary of what was tested and the outcome (1-3 sentences)',
        },
        failure_reason: {
          type: 'string',
          description: 'If passed=false, describe exactly what failed and what was observed',
        },
      },
      required: ['passed', 'summary'],
    },
  },
];

/** Names of all available tools, for fast lookup */
export const TOOL_NAMES = new Set(BROWSER_TOOLS.map(t => t.name));
