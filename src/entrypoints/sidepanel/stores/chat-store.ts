import { create } from 'zustand';
import { stream as piStream } from '@mariozechner/pi-ai';
import { resolveModel } from '../../../lib/pi-ai-bridge';
import { getSettings, getEncryptedTokens, getEncryptionKeyEncoded } from '../../../lib/storage';
import { decrypt, importKey } from '../../../lib/crypto';

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
  model: any | null;
  apiKey: string | null;
  abortController: AbortController | null;

  initClient: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  cancelStream: () => void;
  clearChat: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [{
    id: 'welcome',
    role: 'assistant',
    content: 'Welcome to Cohand! Describe what you want to automate, and I\'ll help you create a task.',
    timestamp: Date.now(),
  }],
  isStreaming: false,
  error: null,
  model: null,
  apiKey: null,
  abortController: null,

  initClient: async () => {
    try {
      const settings = await getSettings();
      const tokens = await getEncryptedTokens();

      // Decrypt token
      let token = '';
      const keyEncoded = await getEncryptionKeyEncoded();
      if (keyEncoded && tokens.apiKey) {
        const key = await importKey(keyEncoded);
        token = await decrypt(key, tokens.apiKey);
      } else if (tokens.apiKey) {
        // Unencrypted fallback (first setup before encryption)
        token = tokens.apiKey;
      }

      if (!token) {
        set({ error: 'No API key configured. Go to Settings to add one.' });
        return;
      }

      const model = resolveModel(settings);
      set({ model, apiKey: token, error: null });
    } catch (err: any) {
      set({ error: `Failed to initialize LLM: ${err.message}` });
    }
  },

  sendMessage: async (content: string) => {
    const { model, apiKey, messages } = get();
    if (!model || !apiKey) {
      set({ error: 'LLM not initialized' });
      return;
    }

    const userMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
    };

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
          set(state => ({
            messages: state.messages.map(m =>
              m.id === assistantMessage.id
                ? { ...m, content: fullContent }
                : m
            ),
          }));
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
    } catch (err: any) {
      if (err.name === 'AbortError') {
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
        set(state => ({
          messages: state.messages.map(m =>
            m.id === assistantMessage.id
              ? { ...m, content: `Error: ${err.message}`, streaming: false }
              : m
          ),
          isStreaming: false,
          error: err.message,
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
        content: 'Welcome to Cohand! Describe what you want to automate, and I\'ll help you create a task.',
        timestamp: Date.now(),
      }],
      isStreaming: false,
      error: null,
      abortController: null,
    });
  },
}));
