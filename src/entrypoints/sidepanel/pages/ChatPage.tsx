import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../stores/chat-store';
import { useRecordingStore } from '../stores/recording-store';
import { ChatMessageBubble } from '../components/ChatMessage';
import { RecordingToolbar } from '../components/RecordingToolbar';
import { LiveStepList } from '../components/LiveStepList';
import { RecordingStartModal } from '../components/RecordingStartModal';

export function ChatPage() {
  const { messages, isStreaming, error, sendMessage, cancelStream } = useChatStore();
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

  return (
    <div className="flex flex-col h-full">
      {isRecording ? (
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

      {error && (
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
