import { LLMClient } from './llm-client';
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
  client: LLMClient,
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

  const response = await client.chat(messages as any);

  // Clean up response — strip markdown code fences if present
  const source = cleanScriptSource(response);

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
  client: LLMClient,
  params: {
    source: string;
    error: string;
    a11yTree: string;
    schema?: string;
    lastOutput?: string;
  },
): Promise<ScriptGenerationResult> {
  const messages = buildRepairMessages(params);
  const response = await client.chat(messages);
  const source = cleanScriptSource(response);
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
