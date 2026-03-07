import { create } from 'zustand';

export type WizardStep = 'describe' | 'domains' | 'observe' | 'review' | 'test' | 'schedule';

interface WizardState {
  step: WizardStep;
  description: string;
  domains: string[];
  currentTabUrl: string | null;
  generatedScript: string | null;
  astValid: boolean;
  securityPassed: boolean;
  testResult: { success: boolean; result?: unknown; error?: string } | null;
  schedule: { type: 'manual' } | { type: 'interval'; intervalMinutes: number };
  loading: boolean;
  error: string | null;

  setDescription: (desc: string) => void;
  addDomain: (domain: string) => void;
  removeDomain: (domain: string) => void;
  detectCurrentTab: () => Promise<void>;
  startObservation: () => Promise<void>;
  runTest: () => Promise<void>;
  setSchedule: (schedule: WizardState['schedule']) => void;
  createTask: () => Promise<void>;
  nextStep: () => void;
  prevStep: () => void;
  reset: () => void;
}

const STEPS: WizardStep[] = ['describe', 'domains', 'observe', 'review', 'test', 'schedule'];

export const useWizardStore = create<WizardState>((set, get) => ({
  step: 'describe',
  description: '',
  domains: [],
  currentTabUrl: null,
  generatedScript: null,
  astValid: false,
  securityPassed: false,
  testResult: null,
  schedule: { type: 'manual' },
  loading: false,
  error: null,

  setDescription: (description) => set({ description }),

  addDomain: (domain) => {
    const { domains } = get();
    if (!domains.includes(domain)) {
      set({ domains: [...domains, domain] });
    }
  },

  removeDomain: (domain) => {
    set({ domains: get().domains.filter(d => d !== domain) });
  },

  detectCurrentTab: async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url) {
        const url = new URL(tab.url);
        set({
          currentTabUrl: tab.url,
          domains: [url.hostname],
        });
      }
    } catch { /* ignore */ }
  },

  startObservation: async () => {
    set({ loading: true, error: null });
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab');

      const response = await chrome.runtime.sendMessage({
        type: 'GENERATE_SCRIPT',
        tabId: tab.id,
        description: get().description,
        domains: get().domains,
      });

      set({
        generatedScript: response.source,
        astValid: response.astValid,
        securityPassed: response.securityPassed ?? false,
        loading: false,
      });
    } catch (err: unknown) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  runTest: async () => {
    set({ loading: true, error: null, testResult: null });
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab');

      const response = await chrome.runtime.sendMessage({
        type: 'TEST_SCRIPT',
        tabId: tab.id,
        source: get().generatedScript,
        domains: get().domains,
      });

      set({
        testResult: {
          success: response.ok,
          result: response.result,
          error: response.error,
        },
        loading: false,
      });
    } catch (err: unknown) {
      set({
        testResult: { success: false, error: err instanceof Error ? err.message : String(err) },
        loading: false,
      });
    }
  },

  setSchedule: (schedule) => set({ schedule }),

  createTask: async () => {
    set({ loading: true, error: null });
    try {
      const { description, domains, generatedScript, schedule } = get();
      await chrome.runtime.sendMessage({
        type: 'CREATE_TASK',
        task: {
          id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: description.slice(0, 80),
          description,
          allowedDomains: domains,
          schedule,
          activeScriptVersion: 1,
          disabled: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        scriptSource: generatedScript,
      });
      set({ loading: false });
    } catch (err: unknown) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  nextStep: () => {
    const idx = STEPS.indexOf(get().step);
    if (idx < STEPS.length - 1) set({ step: STEPS[idx + 1] });
  },

  prevStep: () => {
    const idx = STEPS.indexOf(get().step);
    if (idx > 0) set({ step: STEPS[idx - 1] });
  },

  reset: () => set({
    step: 'describe',
    description: '',
    domains: [],
    currentTabUrl: null,
    generatedScript: null,
    astValid: false,
    securityPassed: false,
    testResult: null,
    schedule: { type: 'manual' },
    loading: false,
    error: null,
  }),
}));
