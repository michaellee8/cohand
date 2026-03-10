// src/lib/recording/recording-prompts.ts
import type { RecordingStepRecord } from '../../types/recording';

export const RECORDING_SYSTEM_PROMPT = `You are an expert browser automation script generator.
You are given a user's workflow recording (demonstration steps with selectors, a11y trees, and screenshots)
plus their refinement instructions. Generate a JavaScript automation script using the HumanizedPage API.

The recording is TEACHING MATERIAL — not a literal replay template. You may:
- Add loops, conditionals, state management, error handling
- Use different selectors than what was recorded if more robust options exist
- Skip recorded steps or add new ones based on the user's instructions
- Generate logic that looks nothing like the literal recording

Available page methods: goto, click, fill, type, scroll, waitForSelector, waitForLoadState,
url, title, getByRole, getByText, getByLabel, locator

Available context: context.url, context.state, context.notify(message)

Output TWO things separated by a delimiter:
1. A natural-language TASK DESCRIPTION (1-3 sentences, non-technical)
2. The JavaScript script (async function run(page, context) { ... })

Use this format:
---DESCRIPTION---
[task description here]
---SCRIPT---
[script code here]`;

export function buildRecordingGenerationMessages(params: {
  steps: Array<Partial<RecordingStepRecord>>;
  pageSnapshots: Array<{ snapshotKey: string; tree: unknown }>;
  refinementInstructions: string;
  domains: string[];
}): Array<{ role: 'system' | 'user'; content: string }> {
  const stepsText = params.steps.map((s, i) =>
    `${i + 1}. [${s.action}] ${s.description ?? s.selector ?? 'unknown'}` +
    (s.typedText ? ` — typed: "${s.typedText}"` : '') +
    (s.url ? ` — url: ${s.url}` : ''),
  ).join('\n');

  const snapshotsText = params.pageSnapshots.map(s =>
    `### ${s.snapshotKey}\n${JSON.stringify(s.tree, null, 2).slice(0, 5000)}`,
  ).join('\n\n');

  return [
    { role: 'system', content: RECORDING_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `## Recorded Steps\n${stepsText}\n\n## Page Snapshots\n${snapshotsText}\n\n## Allowed Domains\n${params.domains.join(', ')}\n\n## User Instructions\n${params.refinementInstructions}`,
    },
  ];
}

export function parseGenerationOutput(raw: string): { description: string; script: string } {
  const descSplit = raw.indexOf('---DESCRIPTION---');
  const scriptSplit = raw.indexOf('---SCRIPT---');
  if (descSplit === -1 || scriptSplit === -1) {
    return { description: '', script: raw };
  }
  const description = raw.slice(descSplit + '---DESCRIPTION---'.length, scriptSplit).trim();
  const script = raw.slice(scriptSplit + '---SCRIPT---'.length).trim()
    .replace(/^```javascript\n?/, '').replace(/\n?```$/, '');
  return { description, script };
}
