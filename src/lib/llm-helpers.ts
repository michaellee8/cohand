import type { Context, Message, UserMessage, AssistantMessage } from '@mariozechner/pi-ai';

/**
 * Convert a raw messages array into a pi-ai Context object.
 */
export function toContext(
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
export function extractText(result: AssistantMessage): string {
  if (!result.content || !Array.isArray(result.content)) return '';
  return result.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}
