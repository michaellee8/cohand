interface ChatMessageProps {
  role: 'user' | 'assistant' | 'system';
  content: string;
  streaming?: boolean;
}

export function ChatMessageBubble({ role, content, streaming }: ChatMessageProps) {
  const isUser = role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
        isUser
          ? 'bg-blue-500 text-white'
          : 'bg-gray-100 text-gray-800'
      }`}>
        <div className="whitespace-pre-wrap break-words">{content}</div>
        {streaming && (
          <span className="inline-block w-1.5 h-4 bg-current opacity-50 animate-pulse ml-0.5" />
        )}
      </div>
    </div>
  );
}
