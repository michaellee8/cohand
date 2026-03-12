import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useRecordingStore } from './recording-store';

// ---------------------------------------------------------------------------
// Chrome API mocks
// ---------------------------------------------------------------------------

const SERVER_SESSION_ID = 'rec-server-uuid-1234';

const mockSendMessage = vi.fn();
const mockTabsSendMessage = vi.fn();

vi.stubGlobal('chrome', {
  runtime: {
    sendMessage: mockSendMessage,
  },
  tabs: {
    sendMessage: mockTabsSendMessage,
  },
});

beforeEach(() => {
  // Reset the store to initial state
  useRecordingStore.getState().reset();
  vi.clearAllMocks();

  // Default: START_RECORDING returns sessionId from server
  mockSendMessage.mockResolvedValue({ ok: true, sessionId: SERVER_SESSION_ID });
  mockTabsSendMessage.mockResolvedValue({ ok: true });
});

describe('recording-store C5: sessionId from server', () => {
  it('uses sessionId returned by the service worker, not a client-side id', async () => {
    await useRecordingStore.getState().startRecording(42);

    const { session } = useRecordingStore.getState();
    expect(session).not.toBeNull();
    expect(session!.id).toBe(SERVER_SESSION_ID);
  });

  it('does not generate a client-side rec- id', async () => {
    await useRecordingStore.getState().startRecording(42);

    const { session } = useRecordingStore.getState();
    // Should NOT match the old pattern (rec-<timestamp>-<random>)
    expect(session!.id).not.toMatch(/^rec-\d+-[a-z0-9]+$/);
    expect(session!.id).toBe(SERVER_SESSION_ID);
  });

  it('sends START_RECORDING to service worker before creating session', async () => {
    await useRecordingStore.getState().startRecording(99);

    expect(mockSendMessage).toHaveBeenCalledWith({
      type: 'START_RECORDING',
      tabId: 99,
    });
  });

  it('sets error and resets when service worker fails', async () => {
    mockSendMessage.mockRejectedValueOnce(new Error('SW unavailable'));

    await useRecordingStore.getState().startRecording(42);

    const state = useRecordingStore.getState();
    expect(state.isRecording).toBe(false);
    expect(state.session).toBeNull();
    expect(state.error).toBe('SW unavailable');
  });

  it('sets isRecording true immediately before awaiting server', async () => {
    // Use a deferred promise to capture intermediate state
    let resolveMsg: (v: any) => void;
    mockSendMessage.mockReturnValueOnce(
      new Promise((r) => { resolveMsg = r; }),
    );

    const startPromise = useRecordingStore.getState().startRecording(42);

    // Intermediate state: recording started, no session yet
    expect(useRecordingStore.getState().isRecording).toBe(true);
    expect(useRecordingStore.getState().session).toBeNull();

    // Resolve the server response
    resolveMsg!({ ok: true, sessionId: SERVER_SESSION_ID });
    await startPromise;

    expect(useRecordingStore.getState().session!.id).toBe(SERVER_SESSION_ID);
  });
});
