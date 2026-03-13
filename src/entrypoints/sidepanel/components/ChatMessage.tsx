import { useMemo } from 'react';

interface ChatMessageProps {
  role: 'user' | 'assistant' | 'system';
  content: string;
  streaming?: boolean;
}

/**
 * Lightweight Markdown renderer for chat messages.
 * Supports: code blocks (```), inline code (`), bold (**), italic (*), headers (#).
 */
function renderMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      nodes.push(
        <pre key={nodes.length} className="bg-gray-800 text-gray-100 rounded px-3 py-2 my-1.5 text-xs font-mono overflow-x-auto">
          {lang && <div className="text-gray-400 text-[10px] mb-1">{lang}</div>}
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // Header lines
    if (/^#{1,3}\s/.test(line)) {
      const level = line.match(/^(#+)/)?.[1].length ?? 1;
      const text = line.replace(/^#+\s*/, '');
      const Tag = level === 1 ? 'h3' : level === 2 ? 'h4' : 'h5';
      nodes.push(
        <Tag key={nodes.length} className="font-semibold mt-2 mb-1">
          {renderInline(text)}
        </Tag>
      );
      i++;
      continue;
    }

    // Regular line with inline formatting
    nodes.push(
      <div key={nodes.length}>
        {line === '' ? <br /> : renderInline(line)}
      </div>
    );
    i++;
  }

  return nodes;
}

/** Render inline markdown: bold, italic, inline code */
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Match: `code`, **bold**, *italic*
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const segment = match[0];
    if (segment.startsWith('`')) {
      parts.push(
        <code key={parts.length} className="bg-gray-200 text-gray-800 rounded px-1 py-0.5 text-xs font-mono">
          {segment.slice(1, -1)}
        </code>
      );
    } else if (segment.startsWith('**')) {
      parts.push(<strong key={parts.length}>{segment.slice(2, -2)}</strong>);
    } else if (segment.startsWith('*')) {
      parts.push(<em key={parts.length}>{segment.slice(1, -1)}</em>);
    }
    lastIndex = match.index + segment.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

export function ChatMessageBubble({ role, content, streaming }: ChatMessageProps) {
  const isUser = role === 'user';
  const rendered = useMemo(() => isUser ? null : renderMarkdown(content), [content, isUser]);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
        isUser
          ? 'bg-blue-500 text-white'
          : 'bg-gray-100 text-gray-800'
      }`}>
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{content}</div>
        ) : (
          <div className="break-words">{rendered}</div>
        )}
        {streaming && (
          <span className="inline-block w-1.5 h-4 bg-current opacity-50 animate-pulse ml-0.5" />
        )}
      </div>
    </div>
  );
}
