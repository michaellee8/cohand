import { complete } from '@mariozechner/pi-ai';
import type { ModelLike } from './pi-ai-bridge';
import { toContext, extractText } from './llm-helpers';
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
 * Generate an automation script from a natural language description.
 */
export async function generateScript(
  model: ModelLike,
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
  model: ModelLike,
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
