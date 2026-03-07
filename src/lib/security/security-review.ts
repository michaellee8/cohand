import type { ReviewDetail } from '../../types';
import type { LLMClient } from '../llm-client';
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
  clients: [LLMClient, LLMClient],
  previousApprovedSource?: string,
): Promise<SecurityReviewResult> {
  const [client1, client2] = clients;

  const [result1, result2] = await Promise.all([
    runSingleReview(source, client1, 'data_flow', previousApprovedSource),
    runSingleReview(source, client2, 'capability', previousApprovedSource),
  ]);

  return {
    approved: result1.approved && result2.approved,
    details: [result1, result2],
  };
}

async function runSingleReview(
  source: string,
  client: LLMClient,
  promptType: 'data_flow' | 'capability',
  previousApprovedSource?: string,
): Promise<ReviewDetail> {
  const messages = buildReviewMessages(source, promptType, previousApprovedSource);

  try {
    const response = await client.chat(messages, {
      temperature: 0,
      jsonMode: true,
    });

    const parsed = JSON.parse(response);

    // Validate response shape
    if (typeof parsed.approved !== 'boolean') {
      return {
        model: client.modelName,
        approved: false, // fail-closed: malformed response = rejection
        issues: ['Malformed review response: missing approved field'],
      };
    }

    return {
      model: client.modelName,
      approved: parsed.approved,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    };
  } catch (err: unknown) {
    // Fail-closed: any error = rejection
    const message = err instanceof Error ? err.message : String(err);
    return {
      model: client.modelName,
      approved: false,
      issues: [`Review error: ${message}`],
    };
  }
}
