import { complete } from '@mariozechner/pi-ai';
import type { Context, Message, UserMessage, AssistantMessage } from '@mariozechner/pi-ai';
import { validateAST } from './security/ast-validator';
import { buildGenerationMessages, buildRepairMessages } from './explorer-prompts';

export interface ExplorationResult {
  a11yTree: string;
  screenshot?: string; // base64 data URL
  url: string;
  title: string;
}

export interface ScriptGenerationResult {
  source: string;
  astValid: boolean;
  astErrors: string[];
}

/**
 * Convert the messages array from buildGenerationMessages / buildRepairMessages
 * into a pi-ai Context object (systemPrompt + messages).
 */
function toContext(
  rawMessages: Array<{ role: string; content: string | Array<{ type: string; [key: string]: any }> }>,
): Context {
  let systemPrompt: string | undefined;
  const messages: Message[] = [];

  for (const msg of rawMessages) {
    if (msg.role === 'system') {
      systemPrompt = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    } else if (msg.role === 'user') {
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      messages.push({ role: 'user', content, timestamp: Date.now() } as UserMessage);
    }
  }

  return { systemPrompt, messages };
}

/**
 * Extract the text content from a pi-ai AssistantMessage.
 */
function extractText(result: AssistantMessage): string {
  const textParts = result.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text);
  return textParts.join('');
}

/**
 * Observe a page by getting its a11y tree and screenshot.
 * Uses message passing to content script and chrome.tabs API.
 */
export async function observePage(tabId: number): Promise<ExplorationResult> {
  // Get a11y tree from content script
  const tree = await chrome.runtime.sendMessage({ type: 'GET_A11Y_TREE', tabId });

  // Get screenshot
  const tab = await chrome.tabs.get(tabId);
  let screenshot: string | undefined;
  try {
    screenshot = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: 'png' });
  } catch {
    // Screenshot may fail on restricted pages
  }

  return {
    a11yTree: JSON.stringify(tree, null, 2),
    screenshot,
    url: tab.url || '',
    title: tab.title || '',
  };
}

/**
 * Generate an automation script from a natural language description.
 */
export async function generateScript(
  model: any,
  apiKey: string,
  description: string,
  observation: ExplorationResult,
  domains: string[],
): Promise<ScriptGenerationResult> {
  const messages = buildGenerationMessages({
    description,
    url: observation.url,
    domains,
    a11yTree: observation.a11yTree,
    screenshot: observation.screenshot,
  });

  const context = toContext(messages);
  const result = await complete(model, context, { apiKey });

  // Clean up response — strip markdown code fences if present
  const source = cleanScriptSource(extractText(result));

  // Validate AST
  const validation = validateAST(source);

  return {
    source,
    astValid: validation.valid,
    astErrors: validation.errors,
  };
}

/**
 * Generate a repair for a failing script.
 */
export async function repairScript(
  model: any,
  apiKey: string,
  params: {
    source: string;
    error: string;
    a11yTree: string;
    schema?: string;
    lastOutput?: string;
  },
): Promise<ScriptGenerationResult> {
  const messages = buildRepairMessages(params);
  const context = toContext(messages);
  const result = await complete(model, context, { apiKey });
  const source = cleanScriptSource(extractText(result));
  const validation = validateAST(source);

  return {
    source,
    astValid: validation.valid,
    astErrors: validation.errors,
  };
}

/**
 * Strip markdown code fences from LLM output.
 */
export function cleanScriptSource(raw: string): string {
  let source = raw.trim();
  // Remove ```javascript ... ``` wrapper
  if (source.startsWith('```')) {
    const firstNewline = source.indexOf('\n');
    source = source.slice(firstNewline + 1);
    if (source.endsWith('```')) {
      source = source.slice(0, -3);
    }
  }
  return source.trim();
}
