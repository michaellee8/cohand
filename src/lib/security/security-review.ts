import { complete } from '@mariozechner/pi-ai';
import type { ModelLike } from '../pi-ai-bridge';
import { toContext, extractText } from '../llm-helpers';
import type { ReviewDetail } from '../../types';
import { buildReviewMessages } from './review-prompts';

export interface SecurityReviewResult {
  approved: boolean;
  details: ReviewDetail[];
}

/**
 * Run dual-model security review on a script.
 * Both models must approve. Fail-closed on any error.
 */
export async function securityReview(
  source: string,
  models: [ModelLike, ModelLike],
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
  model: ModelLike,
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
