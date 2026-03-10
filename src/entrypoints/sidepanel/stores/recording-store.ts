import { create } from 'zustand';
import type { RecordingSession, RecordingStep } from '../../../types/recording';

interface RecordingState {
  isRecording: boolean;
  isPaused: boolean;
  session: RecordingSession | null;
  voiceEnabled: boolean;
  error: string | null;

  startRecording: (tabId: number) => Promise<void>;
  stopRecording: () => Promise<void>;
  togglePause: () => void;
  toggleVoice: () => void;
  removeStep: (stepId: string) => void;
  appendStep: (step: RecordingStep) => void;
  updateStepDescription: (stepId: string, description: string) => void;
  addPageSnapshot: (snapshotKey: string, tree: unknown) => void;
  reset: () => void;
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  isRecording: false,
  isPaused: false,
  session: null,
  voiceEnabled: false,
  error: null,

  startRecording: async (tabId: number) => {
    const sessionId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session: RecordingSession = {
      id: sessionId,
      startedAt: new Date().toISOString(),
      activeTabId: tabId,
      trackedTabs: [tabId],
      pageSnapshots: {},
      steps: [],
    };
    set({ isRecording: true, isPaused: false, session, error: null });

    try {
      await chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId });
      await chrome.tabs.sendMessage(tabId, { type: 'ACTIVATE_RECORDING' });
    } catch (err: any) {
      set({ isRecording: false, session: null, error: err.message });
    }
  },

  stopRecording: async () => {
    const { session } = get();
    if (!session) return;
    try {
      await chrome.tabs.sendMessage(session.activeTabId, { type: 'DEACTIVATE_RECORDING' });
      await chrome.runtime.sendMessage({ type: 'STOP_RECORDING', sessionId: session.id });
    } catch { /* best effort */ }
    set(state => ({
      isRecording: false,
      isPaused: false,
      session: state.session ? { ...state.session, completedAt: new Date().toISOString() } : null,
    }));
  },

  togglePause: () => set(state => ({ isPaused: !state.isPaused })),
  toggleVoice: () => set(state => ({ voiceEnabled: !state.voiceEnabled })),

  removeStep: (stepId) => {
    set(state => {
      if (!state.session) return state;
      return { session: { ...state.session, steps: state.session.steps.filter(s => s.id !== stepId) } };
    });
    chrome.runtime.sendMessage({ type: 'DELETE_RECORDING_STEP', stepId }).catch(() => {});
  },

  appendStep: (step) => set(state => {
    if (!state.session) return state;
    return { session: { ...state.session, steps: [...state.session.steps, step] } };
  }),

  updateStepDescription: (stepId, description) => set(state => {
    if (!state.session) return state;
    return {
      session: {
        ...state.session,
        steps: state.session.steps.map(s =>
          s.id === stepId ? { ...s, description, status: 'described' as const } : s,
        ),
      },
    };
  }),

  addPageSnapshot: (snapshotKey, tree) => set(state => {
    if (!state.session) return state;
    return { session: { ...state.session, pageSnapshots: { ...state.session.pageSnapshots, [snapshotKey]: tree as any } } };
  }),

  reset: () => set({ isRecording: false, isPaused: false, session: null, voiceEnabled: false, error: null }),
}));
