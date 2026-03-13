import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../stores/chat-store';
import { useSettingsStore } from '../stores/settings-store';
import { useRecordingStore } from '../stores/recording-store';
import { ChatMessageBubble } from '../components/ChatMessage';
import { RecordingToolbar } from '../components/RecordingToolbar';
import { LiveStepList } from '../components/LiveStepList';
import { RecordingStartModal } from '../components/RecordingStartModal';

interface ChatPageProps {
  onOpenSettings: () => void;
}

export function ChatPage({ onOpenSettings }: ChatPageProps) {
  const { messages, isStreaming, error, sendMessage, cancelStream } = useChatStore();
  const { settings, hasApiKey, codexConnected } = useSettingsStore();
  const { isRecording } = useRecordingStore();
  const [input, setInput] = useState('');
  const [showRecordModal, setShowRecordModal] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    useChatStore.getState().initClient();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = () => {
    if (!input.trim() || isStreaming) return;
    sendMessage(input.trim());
    setInput('');
  };

  const llmConfigured = settings
    ? settings.llmProvider === 'chatgpt-subscription'
      ? codexConnected
      : hasApiKey
    : true; // assume configured while settings are loading

  return (
    <div className="flex flex-col h-full">
      {!llmConfigured ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-center">
          <svg className="w-12 h-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          </svg>
          <div>
            <p className="text-base font-semibold text-gray-900">No LLM configured</p>
            <p className="text-sm text-gray-500 mt-1">Set up your LLM provider to start using Cohand</p>
          </div>
          <button
            onClick={onOpenSettings}
            className="bg-blue-500 text-white rounded-lg px-6 py-2.5 text-sm font-medium hover:bg-blue-600 transition-colors"
          >
            Go to Settings
          </button>
        </div>
      ) : isRecording ? (
        <LiveStepList />
      ) : (
        <div className="flex-1 p-4 overflow-y-auto">
          {messages.map(msg => (
            <ChatMessageBubble
              key={msg.id}
              role={msg.role}
              content={msg.content}
              streaming={msg.streaming}
            />
          ))}
          <div ref={messagesEndRef} />
        </div>
      )}

      {error && llmConfigured && (
        <div className="px-4 py-2 bg-red-50 text-red-600 text-xs">{error}</div>
      )}

      {isRecording && <RecordingToolbar />}

      <div className="p-3 border-t border-gray-200">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSubmit()}
            placeholder="Describe your task..."
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            disabled={isStreaming || isRecording}
          />
          <button
            onClick={() => setShowRecordModal(true)}
            disabled={isRecording || isStreaming}
            className="text-gray-400 hover:text-red-500 p-2 rounded-lg transition-colors disabled:opacity-30"
            title="Record workflow"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="8" />
            </svg>
          </button>
          {isStreaming ? (
            <button
              onClick={cancelStream}
              className="bg-red-500 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-red-600 transition-colors"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={!input.trim()}
              className="bg-blue-500 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-600 transition-colors disabled:opacity-50"
            >
              Send
            </button>
          )}
        </div>
      </div>

      {showRecordModal && <RecordingStartModal onClose={() => setShowRecordModal(false)} />}
    </div>
  );
}
