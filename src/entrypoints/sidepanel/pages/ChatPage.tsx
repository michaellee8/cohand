import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../stores/chat-store';
import { useSettingsStore } from '../stores/settings-store';
import { useRecordingStore } from '../stores/recording-store';
import { useWizardStore } from '../stores/wizard-store';
import { useDomainSessionStore } from '../stores/domain-session-store';
import { ChatMessageBubble } from '../components/ChatMessage';
import { RecordingToolbar } from '../components/RecordingToolbar';
import { LiveStepList } from '../components/LiveStepList';
import { RecordingStartModal } from '../components/RecordingStartModal';
import { CreateTaskWizard } from '../components/CreateTaskWizard';
import { DomainApprovalPrompt } from '../components/DomainApprovalPrompt';
import { ExplorerAgentFeedback } from '../components/ExplorerAgentFeedback';

interface ChatPageProps {
  onOpenSettings: () => void;
}

export function ChatPage({ onOpenSettings }: ChatPageProps) {
  const { messages, isStreaming, error, explorerSteps, sendMessage, cancelStream,
    generatedScript, generatedDescription, clearGeneratedScript } = useChatStore();
  const { settings, hasApiKey, codexConnected } = useSettingsStore();
  const { isRecording, session } = useRecordingStore();
  const {
    pendingApprovals,
    yoloMode,
    load: loadDomainSession,
    approveDomain,
    denyDomain,
  } = useDomainSessionStore();
  const [input, setInput] = useState('');
  const [showRecordModal, setShowRecordModal] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Detect recording completion: session exists, has completedAt, and not currently recording
  const recordingJustCompleted = !isRecording && session?.completedAt && session.steps.length > 0;

  // Track whether we've submitted refinement for this session to avoid re-showing summary
  const [refinementSubmittedForSession, setRefinementSubmittedForSession] = useState<string | null>(null);
  const hasSubmittedRefinement = refinementSubmittedForSession === session?.id;

  useEffect(() => {
    useChatStore.getState().initClient();
    loadDomainSession();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, generatedDescription, pendingApprovals, explorerSteps]);

  const handleSubmit = () => {
    if (!input.trim() || isStreaming) return;
    sendMessage(input.trim());
    setInput('');
  };

  const handleRefinementSubmit = () => {
    if (!input.trim() || isStreaming || !session) return;
    setRefinementSubmittedForSession(session.id);
    useChatStore.getState().submitRecordingRefinement(session, input.trim());
    setInput('');
  };

  const handleApproveDomain = async (requestId: string) => {
    await approveDomain(requestId);
  };

  const handleDenyDomain = (requestId: string) => {
    denyDomain(requestId);
    // Cancel any ongoing stream since generation was denied
    cancelStream();
  };

  const handleCreateTask = () => {
    if (!generatedScript || !generatedDescription || !session) return;
    // Pre-fill wizard with recording data
    const wizardStore = useWizardStore.getState();
    wizardStore.reset();
    wizardStore.setDescription(generatedDescription);
    // Extract domains from recorded steps
    const urls = session.steps
      .map(s => s.url)
      .filter((u): u is string => !!u);
    const uniqueDomains = [...new Set(urls.map(u => {
      try { return new URL(u).hostname; } catch { return null; }
    }).filter((d): d is string => !!d))];
    uniqueDomains.forEach(d => wizardStore.addDomain(d));
    setShowWizard(true);
  };

  const handleWizardComplete = () => {
    setShowWizard(false);
    useWizardStore.getState().reset();
    useRecordingStore.getState().reset();
    useChatStore.getState().clearChat();
    useDomainSessionStore.getState().clearSession();
    setRefinementSubmittedForSession(null);
  };

  const handleWizardCancel = () => {
    setShowWizard(false);
    useWizardStore.getState().reset();
  };

  const llmConfigured = settings
    ? settings.llmProvider === 'chatgpt-subscription'
      ? codexConnected
      : hasApiKey
    : true; // assume configured while settings are loading

  if (showWizard) {
    return <CreateTaskWizard onComplete={handleWizardComplete} onCancel={handleWizardCancel} />;
  }

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
          {/* Normal chat messages */}
          {messages.map(msg => (
            <ChatMessageBubble
              key={msg.id}
              role={msg.role}
              content={msg.content}
              streaming={msg.streaming}
            />
          ))}

          {/* Recording just completed: show step summary */}
          {recordingJustCompleted && !hasSubmittedRefinement && session && (
            <div className="flex justify-start mb-3">
              <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-800">
                <p className="font-medium mb-2">
                  I recorded your workflow ({session.steps.length} step{session.steps.length !== 1 ? 's' : ''}):
                </p>
                <ol className="list-decimal list-inside space-y-1 mb-2">
                  {session.steps.map((step, i) => (
                    <li key={step.id || i} className="text-sm">
                      {step.description
                        || `${step.action}${step.selector ? ` on ${step.selector}` : ''}${step.url ? ` (${step.url})` : ''}`}
                    </li>
                  ))}
                </ol>
                <p className="text-gray-500 text-xs mt-2">
                  What would you like me to do with this workflow? Type your instructions below.
                </p>
              </div>
            </div>
          )}

          {/* After refinement submitted and description generated */}
          {hasSubmittedRefinement && generatedDescription && (
            <div className="flex justify-start mb-3">
              <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-800">
                <p className="font-medium mb-1">Task Description:</p>
                <p className="mb-3">{generatedDescription}</p>
                <div className="flex gap-2">
                  <button
                    onClick={handleCreateTask}
                    className="bg-blue-500 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-600 transition-colors"
                  >
                    Create Task
                  </button>
                  <button
                    onClick={() => clearGeneratedScript()}
                    className="text-sm text-gray-500 px-2 hover:text-gray-700 transition-colors"
                  >
                    Discard
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Streaming indicator for refinement */}
          {hasSubmittedRefinement && isStreaming && !generatedDescription && (
            <div className="flex justify-start mb-3">
              <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-800">
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-blue-200 border-t-blue-500 rounded-full animate-spin" />
                  <span className="text-gray-500">Generating script from your recording...</span>
                </div>
              </div>
            </div>
          )}

          {/* Domain approval prompts inline in chat */}
          {pendingApprovals.map(request => (
            <DomainApprovalPrompt
              key={request.id}
              request={request}
              yoloMode={yoloMode}
              onApprove={handleApproveDomain}
              onDeny={handleDenyDomain}
            />
          ))}

          {/* Explorer agent visual feedback */}
          {explorerSteps.length > 0 && (
            <ExplorerAgentFeedback steps={explorerSteps} />
          )}

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
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                if (recordingJustCompleted && !hasSubmittedRefinement) {
                  handleRefinementSubmit();
                } else {
                  handleSubmit();
                }
              }
            }}
            placeholder={recordingJustCompleted && !hasSubmittedRefinement
              ? "Describe what you want this workflow to do..."
              : "Describe your task..."}
            aria-label="Chat message input"
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            disabled={isStreaming || isRecording}
          />
          <button
            onClick={() => setShowRecordModal(true)}
            disabled={isRecording || isStreaming}
            className="text-gray-400 hover:text-red-500 p-2 rounded-lg transition-colors disabled:opacity-30"
            title="Record workflow"
            aria-label="Record workflow"
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
              onClick={recordingJustCompleted && !hasSubmittedRefinement
                ? handleRefinementSubmit
                : handleSubmit}
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
