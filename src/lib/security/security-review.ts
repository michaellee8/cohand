import { complete } from '@mariozechner/pi-ai';
import type { Context, Message, UserMessage, AssistantMessage } from '@mariozechner/pi-ai';
import type { ReviewDetail } from '../../types';
import { buildReviewMessages } from './review-prompts';

export interface SecurityReviewResult {
  approved: boolean;
  details: ReviewDetail[];
}

/**
 * Convert the messages array from buildReviewMessages into a pi-ai Context.
 */
function toContext(
  rawMessages: Array<{ role: string; content: string }>,
): Context {
  const systemPrompt = rawMessages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');

  const messages: Message[] = rawMessages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
      timestamp: Date.now(),
    })) as UserMessage[];

  return { systemPrompt, messages };
}

/**
 * Extract the text content from a pi-ai AssistantMessage.
 */
function extractText(result: AssistantMessage): string {
  if (!result.content || !Array.isArray(result.content)) return '';
  return result.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/**
 * Run dual-model security review on a script.
 * Both models must approve. Fail-closed on any error.
 */
export async function securityReview(
  source: string,
  models: [any, any],
  apiKey: string,
  previousApprovedSource?: string,
): Promise<SecurityReviewResult> {
  const [model1, model2] = models;

  const [result1, result2] = await Promise.all([
    runSingleReview(source, model1, apiKey, 'data_flow', previousApprovedSource),
    runSingleReview(source, model2, apiKey, 'capability', previousApprovedSource),
  ]);

  return {
    approved: result1.approved && result2.approved,
    details: [result1, result2],
  };
}

async function runSingleReview(
  source: string,
  model: any,
  apiKey: string,
  promptType: 'data_flow' | 'capability',
  previousApprovedSource?: string,
): Promise<ReviewDetail> {
  const messages = buildReviewMessages(source, promptType, previousApprovedSource);
  const context = toContext(messages);

  try {
    const result = await complete(model, context, { apiKey });
    const responseText = extractText(result);
    const parsed = JSON.parse(responseText);

    // Validate response shape
    if (typeof parsed.approved !== 'boolean') {
      return {
        model: model.id,
        approved: false, // fail-closed: malformed response = rejection
        issues: ['Malformed review response: missing approved field'],
      };
    }

    return {
      model: model.id,
      approved: parsed.approved,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    };
  } catch (err: unknown) {
    // Fail-closed: any error = rejection
    const message = err instanceof Error ? err.message : String(err);
    return {
      model: model.id,
      approved: false,
      issues: [`Review error: ${message}`],
    };
  }
}
