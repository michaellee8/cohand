/**
 * Web Speech API wrapper for voice narration during recording.
 *
 * Runs in the Chrome extension sidepanel where the Web Speech API
 * is available. Transcripts are associated with recording steps by
 * timestamp proximity via findAssociatedStepIndex().
 */

import { SPEECH_ASSOCIATION_WINDOW_MS } from '../../constants';

// ---------------------------------------------------------------------------
// Web Speech API type declarations (not yet in TS lib.dom)
// ---------------------------------------------------------------------------

interface SpeechRecognitionEventMap {
  audiostart: Event;
  audioend: Event;
  end: Event;
  error: SpeechRecognitionErrorEvent;
  nomatch: SpeechRecognitionEvent;
  result: SpeechRecognitionEvent;
  soundstart: Event;
  soundend: Event;
  speechstart: Event;
  speechend: Event;
  start: Event;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  grammars: unknown;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;

  onaudiostart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onaudioend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onerror:
    | ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void)
    | null;
  onnomatch:
    | ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void)
    | null;
  onresult:
    | ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void)
    | null;
  onsoundstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onsoundend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onspeechstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onspeechend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null;

  abort(): void;
  start(): void;
  stop(): void;

  addEventListener<K extends keyof SpeechRecognitionEventMap>(
    type: K,
    listener: (this: SpeechRecognition, ev: SpeechRecognitionEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
  prototype: SpeechRecognition;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpeechResult {
  transcript: string;
  startTime: number;
  endTime: number;
  isFinal: boolean;
}

export type SpeechCallback = (result: SpeechResult) => void;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let recognition: SpeechRecognition | null = null;
let callback: SpeechCallback | null = null;
let segmentStart = 0;
let sessionActive = false;
let paused = false;

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export async function checkMicPermission(): Promise<PermissionState> {
  const result = await navigator.permissions.query({
    name: 'microphone' as PermissionName,
  });
  return result.state;
}

export async function requestMicPermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Recognition lifecycle
// ---------------------------------------------------------------------------

export function startSpeechRecognition(onResult: SpeechCallback): void {
  sessionActive = true;
  paused = false;

  if (recognition) {
    stopSpeechRecognition();
    sessionActive = true; // Re-set after stop clears it
  }

  const SpeechRecognitionCtor =
    window.SpeechRecognition ?? window.webkitSpeechRecognition;

  if (!SpeechRecognitionCtor) {
    sessionActive = false;
    throw new Error('SpeechRecognition API is not available in this browser');
  }

  callback = onResult;

  const rec = new SpeechRecognitionCtor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';

  rec.onresult = (event) => {
    if (!sessionActive) return;
    const now = Date.now();
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0].transcript;

      if (result.isFinal) {
        callback?.({
          transcript,
          startTime: segmentStart,
          endTime: now,
          isFinal: true,
        });
        // Reset segment start for next utterance
        segmentStart = now;
      } else {
        if (segmentStart === 0) {
          segmentStart = now;
        }
        callback?.({
          transcript,
          startTime: segmentStart,
          endTime: now,
          isFinal: false,
        });
      }
    }
  };

  rec.onerror = (event) => {
    if (!sessionActive) return;
    if (event.error === 'not-allowed') {
      stopSpeechRecognition();
    }
  };

  rec.onend = () => {
    if (!sessionActive || paused) return;
    // Auto-restart if still active (browser stops after silence)
    try {
      rec.start();
    } catch {
      // Already started or context destroyed — ignore
    }
  };

  segmentStart = Date.now();
  recognition = rec;
  rec.start();
}

export function stopSpeechRecognition(): void {
  sessionActive = false;
  paused = false;

  if (!recognition) return;

  // Prevent auto-restart in the onend handler
  recognition.onend = null;
  recognition.abort();
  recognition = null;
  callback = null;
  segmentStart = 0;
}

export function pauseSpeechRecognition(): void {
  paused = true;
  recognition?.stop();
}

export function resumeSpeechRecognition(): void {
  paused = false;
  try {
    recognition?.start();
  } catch {
    // Already started — ignore
  }
}

// ---------------------------------------------------------------------------
// Step association
// ---------------------------------------------------------------------------

/**
 * Walk stepTimestamps backwards and find the most recent step that is
 * <= speechStartTime and within SPEECH_ASSOCIATION_WINDOW_MS.
 */
export function findAssociatedStepIndex(
  speechStartTime: number,
  stepTimestamps: number[],
): number | null {
  for (let i = stepTimestamps.length - 1; i >= 0; i--) {
    const stepTime = stepTimestamps[i];
    if (stepTime <= speechStartTime) {
      if (speechStartTime - stepTime <= SPEECH_ASSOCIATION_WINDOW_MS) {
        return i;
      }
      // Past the window — no earlier step will be closer
      return null;
    }
  }
  return null;
}
