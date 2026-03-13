import { create } from 'zustand';
import { stream as piStream, complete as piComplete } from '@mariozechner/pi-ai';
import { resolveModel, resolveApiKey, type ModelLike } from '../../../lib/pi-ai-bridge';
import { getSettings } from '../../../lib/storage';
import type { RecordingSession } from '../../../types/recording';
import { buildRecordingGenerationMessages, parseGenerationOutput } from '../../../lib/recording/recording-prompts';
import type { ExplorerStep } from '../components/ExplorerAgentFeedback';

const WELCOME_MESSAGE = 'Welcome to Cohand! Describe what you want to automate, and I\'ll help you create a task.';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  streaming?: boolean;
}

interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  model: ModelLike | null;
  apiKey: string | null;
  abortController: AbortController | null;

  generatedScript: string | null;
  generatedDescription: string | null;

  /** Explorer agent progress steps shown in chat during task creation. */
  explorerSteps: ExplorerStep[];

  initClient: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  cancelStream: () => void;
  clearChat: () => void;
  submitRecordingRefinement: (recording: RecordingSession, instructions: string) => Promise<void>;
  /** Clear just the generated script/description (e.g., user clicks Discard). */
  clearGeneratedScript: () => void;
  /** Add an explorer agent progress step. */
  addExplorerStep: (step: ExplorerStep) => void;
  /** Clear explorer steps (e.g., when generation completes). */
  clearExplorerSteps: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [{
    id: 'welcome',
    role: 'assistant',
    content: WELCOME_MESSAGE,
    timestamp: Date.now(),
  }],
  isStreaming: false,
  error: null,
  model: null,
  apiKey: null,
  abortController: null,
  generatedScript: null,
  generatedDescription: null,
  explorerSteps: [],

  initClient: async () => {
    try {
      const settings = await getSettings();
      const token = await resolveApiKey(settings);
      const model = resolveModel(settings);
      set({ model, apiKey: token, error: null });
    } catch (err: unknown) {
      set({ error: `Failed to initialize LLM: ${err instanceof Error ? err.message : String(err)}` });
    }
  },

  sendMessage: async (content: string) => {
    const { model, apiKey, messages, abortController: existingController } = get();

    // Abort any existing stream before starting new one
    if (existingController) {
      existingController.abort();
    }

    const userMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
    };

    if (!model || !apiKey) {
      set({ messages: [...messages, userMessage], error: 'LLM not initialized' });
      return;
    }

    const assistantMessage: ChatMessage = {
      id: `msg-${Date.now()}-assistant`,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
    };

    set({
      messages: [...messages, userMessage, assistantMessage],
      isStreaming: true,
      error: null,
    });

    const abortController = new AbortController();
    set({ abortController });

    try {
      // Build pi-ai context from messages
      const context = {
        systemPrompt: '',
        messages: get().messages
          .filter(m => m.id !== assistantMessage.id && m.id !== 'welcome')
          .map(m => ({
            role: m.role as 'user' | 'assistant',
            content: [{ type: 'text' as const, text: m.content }],
            timestamp: m.timestamp,
          })),
      };

      let fullContent = '';
      const result = piStream(model, context as any, { apiKey, signal: abortController.signal, transport: 'sse' });
      for await (const event of result) {
        if (event.type === 'text_delta') {
          fullContent += event.delta;
          set(state => {
            const msgs = [...state.messages];
            const lastIdx = msgs.length - 1;
            msgs[lastIdx] = { ...msgs[lastIdx], content: fullContent };
            return { messages: msgs };
          });
        }
      }

      // Mark streaming complete
      set(state => ({
        messages: state.messages.map(m =>
          m.id === assistantMessage.id
            ? { ...m, streaming: false }
            : m
        ),
        isStreaming: false,
        abortController: null,
      }));
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        set(state => ({
          messages: state.messages.map(m =>
            m.id === assistantMessage.id
              ? { ...m, content: m.content + '\n\n*[Cancelled]*', streaming: false }
              : m
          ),
          isStreaming: false,
          abortController: null,
        }));
      } else {
        const message = err instanceof Error ? err.message : String(err);
        set(state => ({
          messages: state.messages.map(m =>
            m.id === assistantMessage.id
              ? { ...m, content: `Error: ${message}`, streaming: false }
              : m
          ),
          isStreaming: false,
          error: message,
          abortController: null,
        }));
      }
    }
  },

  cancelStream: () => {
    get().abortController?.abort();
  },

  clearChat: () => {
    get().abortController?.abort();
    set({
      messages: [{
        id: 'welcome',
        role: 'assistant',
        content: WELCOME_MESSAGE,
        timestamp: Date.now(),
      }],
      isStreaming: false,
      error: null,
      abortController: null,
      model: null,
      apiKey: null,
      generatedScript: null,
      generatedDescription: null,
      explorerSteps: [],
    });
  },

  submitRecordingRefinement: async (recording: RecordingSession, instructions: string) => {
    const { model, apiKey } = get();
    if (!model || !apiKey) {
      set({ error: 'LLM not initialized' });
      return;
    }

    set({ isStreaming: true, error: null, generatedScript: null, generatedDescription: null });

    try {
      const rawMessages = buildRecordingGenerationMessages({
        steps: recording.steps,
        pageSnapshots: Object.entries(recording.pageSnapshots).map(([snapshotKey, tree]) => ({ snapshotKey, tree })),
        refinementInstructions: instructions,
        domains: [],
      });

      const context = {
        systemPrompt: rawMessages[0].content,
        messages: rawMessages.slice(1).map(m => ({
          role: m.role as 'user' | 'assistant',
          content: [{ type: 'text' as const, text: m.content }],
        })),
      };

      const result = await piComplete(model, context as any, { apiKey, transport: 'sse' });
      const textPart = result.content.find((p): p is { type: 'text'; text: string } => p.type === 'text');
      const text = textPart?.text ?? '';
      const { description, script } = parseGenerationOutput(text);

      set({ generatedScript: script, generatedDescription: description, isStreaming: false });
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : String(err), isStreaming: false });
    }
  },

  clearGeneratedScript: () => {
    set({ generatedScript: null, generatedDescription: null });
  },

  addExplorerStep: (step: ExplorerStep) => {
    set(state => ({ explorerSteps: [...state.explorerSteps, step] }));
  },

  clearExplorerSteps: () => {
    set({ explorerSteps: [] });
  },
}));
