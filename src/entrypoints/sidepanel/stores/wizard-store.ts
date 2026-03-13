import { create } from 'zustand';
import { resolveModel, getSecurityReviewModels, resolveApiKey, type ModelLike } from '../../../lib/pi-ai-bridge';
import { generateScript, type ExplorationResult } from '../../../lib/explorer';
import { securityReview } from '../../../lib/security/security-review';
import { validateAST } from '../../../lib/security/ast-validator';
import { getSettings } from '../../../lib/storage';
import type { ReviewDetail } from '../../../types';

export type WizardStep = 'describe' | 'domains' | 'observe' | 'review' | 'test' | 'schedule';

interface WizardState {
  step: WizardStep;
  description: string;
  domains: string[];
  currentTabUrl: string | null;
  generatedScript: string | null;
  /** Pre-filled script from recording flow — set by ChatPage before opening wizard. */
  pendingScript: { source: string; description: string } | null;
  astValid: boolean;
  astErrors: string[];
  securityPassed: boolean;
  securityReviewDetails: ReviewDetail[];
  testResult: { success: boolean; result?: unknown; error?: string } | null;
  schedule: { type: 'manual' } | { type: 'interval'; intervalMinutes: number };
  loading: boolean;
  error: string | null;

  setDescription: (desc: string) => void;
  addDomain: (domain: string) => void;
  removeDomain: (domain: string) => void;
  setPendingScript: (data: { source: string; description: string } | null) => void;
  detectCurrentTab: () => Promise<void>;
  startObservation: () => Promise<void>;
  runTest: () => Promise<void>;
  setSchedule: (schedule: WizardState['schedule']) => void;
  createTask: () => Promise<boolean>;
  nextStep: () => void;
  prevStep: () => void;
  reset: () => void;
}

const STEPS: WizardStep[] = ['describe', 'domains', 'observe', 'review', 'test', 'schedule'];

/**
 * Initialize a pi-ai model and API key from stored settings and encrypted token.
 */
async function initLLM(): Promise<{ model: ModelLike; apiKey: string }> {
  const settings = await getSettings();
  const apiKey = await resolveApiKey(settings);
  return { model: resolveModel(settings), apiKey };
}

export const useWizardStore = create<WizardState>((set, get) => ({
  step: 'describe',
  description: '',
  domains: [],
  currentTabUrl: null,
  generatedScript: null,
  pendingScript: null,
  astValid: false,
  astErrors: [],
  securityPassed: false,
  securityReviewDetails: [],
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

  setPendingScript: (data) => set({ pendingScript: data }),

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
    } catch (e) {
      set({ error: String(e) });
    }
  },

  startObservation: async () => {
    set({ loading: true, error: null });
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab');

      // Step 1: Get page observation data from service worker
      const treeResponse = await chrome.runtime.sendMessage({
        type: 'GET_A11Y_TREE',
        tabId: tab.id,
      });

      let screenshot: string | undefined;
      try {
        const screenshotResponse = await chrome.runtime.sendMessage({
          type: 'SCREENSHOT',
          tabId: tab.id,
        });
        screenshot = screenshotResponse.dataUrl;
      } catch (e) {
        // Screenshot may fail on restricted pages
        console.warn('[Cohand] Screenshot capture failed:', String(e));
      }

      const observation: ExplorationResult = {
        a11yTree: JSON.stringify(treeResponse?.tree ?? treeResponse ?? {}, null, 2),
        screenshot,
        url: tab.url || '',
        title: tab.title || '',
      };

      // Step 2: Initialize LLM model (side panel makes all LLM calls)
      const { model, apiKey } = await initLLM();

      // Step 3: Generate script via LLM
      const genResult = await generateScript(
        model,
        apiKey,
        get().description,
        observation,
        get().domains,
      );

      // Step 4: Validate AST
      const astResult = validateAST(genResult.source);

      // Step 5: Run dual-model security review (if AST passes)
      let secPassed = false;
      let reviewDetails: ReviewDetail[] = [];
      if (astResult.valid) {
        try {
          const settings = await getSettings();
          const reviewModels = getSecurityReviewModels(settings);
          // Reuse apiKey from above instead of calling initLLM() again
          const reviewResult = await securityReview(genResult.source, reviewModels, apiKey);
          secPassed = reviewResult.approved;
          reviewDetails = reviewResult.details;
        } catch (err) {
          console.warn('[Cohand] Security review failed, marking as not passed:', err);
        }
      }

      // Guard against stale completion — user may have navigated away
      if (get().step !== 'observe') return;

      set({
        generatedScript: genResult.source,
        astValid: astResult.valid,
        astErrors: astResult.errors,
        securityPassed: secPassed,
        securityReviewDetails: reviewDetails,
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
      const { description, domains, generatedScript, schedule, astValid, securityPassed } = get();
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
          notifyEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        scriptSource: generatedScript,
        astValidationPassed: astValid,
        securityReviewPassed: securityPassed,
      });
      set({ loading: false });
      return true;
    } catch (err: unknown) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      return false;
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
    pendingScript: null,
    astValid: false,
    astErrors: [],
    securityPassed: false,
    securityReviewDetails: [],
    testResult: null,
    schedule: { type: 'manual' },
    loading: false,
    error: null,
  }),
}));
