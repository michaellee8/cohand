import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  startSpeechRecognition,
  stopSpeechRecognition,
  type SpeechCallback,
} from './speech';

// ---------------------------------------------------------------------------
// Mock SpeechRecognition
// ---------------------------------------------------------------------------

interface MockRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onend: (() => void) | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

let lastMockRecognition: MockRecognition | null = null;

function createMockRecognitionCtor() {
  // Must be a real function (not arrow) so it can be called with `new`
  function MockSpeechRecognition(this: MockRecognition) {
    this.continuous = false;
    this.interimResults = false;
    this.lang = '';
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.abort = vi.fn();
    lastMockRecognition = this;
  }
  return MockSpeechRecognition as any;
}

beforeEach(() => {
  // Clean up between tests
  stopSpeechRecognition();
  lastMockRecognition = null;
  (window as any).SpeechRecognition = createMockRecognitionCtor();
  delete (window as any).webkitSpeechRecognition;
});

describe('speech race guard (H6)', () => {
  it('does not fire onresult callback after stopSpeechRecognition', () => {
    const cb: SpeechCallback = vi.fn();
    startSpeechRecognition(cb);

    const rec = lastMockRecognition!;
    expect(rec).not.toBeNull();

    // Simulate the browser firing a result
    const fakeEvent = {
      resultIndex: 0,
      results: {
        length: 1,
        0: { 0: { transcript: 'hello' }, isFinal: true, length: 1 },
      },
    };

    // Stop recognition first
    stopSpeechRecognition();

    // Now fire a late result callback (race condition)
    rec.onresult?.(fakeEvent);

    // Callback should NOT have been invoked after stop
    expect(cb).not.toHaveBeenCalled();
  });

  it('does not fire onerror callback after stopSpeechRecognition', () => {
    const cb: SpeechCallback = vi.fn();
    startSpeechRecognition(cb);

    const rec = lastMockRecognition!;

    // Save onerror before stop nulls recognition.onend
    const savedOnerror = rec.onerror;

    stopSpeechRecognition();

    // Late-firing error should be gated
    savedOnerror?.({ error: 'not-allowed', message: '' });

    // No crash, no side effects
    expect(cb).not.toHaveBeenCalled();
  });

  it('does not fire onend callback after stopSpeechRecognition', () => {
    const cb: SpeechCallback = vi.fn();
    startSpeechRecognition(cb);

    const rec = lastMockRecognition!;

    // Save onend before stop nullifies it
    const savedOnend = rec.onend;

    stopSpeechRecognition();

    // Late-firing onend — should not auto-restart
    savedOnend?.();

    // rec.start should have been called exactly once (initial start), not a second time
    expect(rec.start).toHaveBeenCalledTimes(1);
  });

  it('fires callbacks normally while session is active', () => {
    const cb: SpeechCallback = vi.fn();
    startSpeechRecognition(cb);

    const rec = lastMockRecognition!;

    const fakeEvent = {
      resultIndex: 0,
      results: {
        length: 1,
        0: { 0: { transcript: 'hello world' }, isFinal: true, length: 1 },
      },
    };

    rec.onresult?.(fakeEvent);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: 'hello world',
        isFinal: true,
      }),
    );
  });
});
