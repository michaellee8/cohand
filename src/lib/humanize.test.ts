import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateBezierCurve,
  humanizedClick,
  humanizedType,
  humanizedScroll,
  humanizedMouseMove,
} from './humanize';
import { createPRNG } from './prng';
import type { CDPManager } from './cdp';

// Mock setTimeout to resolve instantly
vi.useFakeTimers();

function flushTimers() {
  return vi.runAllTimersAsync();
}

function createMockCDP(initialX = 0, initialY = 0): CDPManager {
  let mouseX = initialX;
  let mouseY = initialY;

  return {
    send: vi.fn().mockResolvedValue(undefined),
    getMousePosition: vi.fn().mockImplementation(() => ({ x: mouseX, y: mouseY })),
    setMousePosition: vi.fn().mockImplementation((_tabId: number, x: number, y: number) => {
      mouseX = x;
      mouseY = y;
    }),
  } as unknown as CDPManager;
}

describe('generateBezierCurve', () => {
  it('produces correct number of points', () => {
    const rng = createPRNG('bezier-count');
    const points = generateBezierCurve(rng, 0, 0, 100, 100, 10);

    // steps + 1 points (0 through steps inclusive)
    expect(points).toHaveLength(11);
  });

  it('starts at the start point', () => {
    const rng = createPRNG('bezier-start');
    const points = generateBezierCurve(rng, 50, 75, 200, 300, 20);

    expect(points[0].x).toBe(50);
    expect(points[0].y).toBe(75);
  });

  it('ends at the end point', () => {
    const rng = createPRNG('bezier-end');
    const points = generateBezierCurve(rng, 50, 75, 200, 300, 20);

    expect(points[points.length - 1].x).toBe(200);
    expect(points[points.length - 1].y).toBe(300);
  });

  it('intermediate points differ from a straight line', () => {
    const rng = createPRNG('bezier-curve');
    const points = generateBezierCurve(rng, 0, 0, 100, 0, 20);

    // At least some y-values should be non-zero (curve bends away from straight line)
    const nonZeroY = points.filter(p => Math.abs(p.y) > 0.01);
    expect(nonZeroY.length).toBeGreaterThan(0);
  });

  it('produces deterministic output with same seed', () => {
    const rng1 = createPRNG('bezier-deterministic');
    const rng2 = createPRNG('bezier-deterministic');

    const points1 = generateBezierCurve(rng1, 0, 0, 100, 100, 10);
    const points2 = generateBezierCurve(rng2, 0, 0, 100, 100, 10);

    expect(points1).toEqual(points2);
  });
});

describe('humanizedClick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('sends mousePressed and mouseReleased events', async () => {
    const cdp = createMockCDP();
    const rng = createPRNG('click-test');
    const tabId = 1;

    const clickPromise = humanizedClick(cdp, tabId, rng, 100, 200);
    await flushTimers();
    await clickPromise;

    const sendCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls;

    // Should have mousePressed somewhere
    const pressedCalls = sendCalls.filter(
      (c: unknown[]) => (c[2] as { type: string })?.type === 'mousePressed',
    );
    expect(pressedCalls).toHaveLength(1);
    expect(pressedCalls[0][2]).toMatchObject({
      type: 'mousePressed',
      x: 100,
      y: 200,
      button: 'left',
      clickCount: 1,
    });

    // Should have mouseReleased somewhere
    const releasedCalls = sendCalls.filter(
      (c: unknown[]) => (c[2] as { type: string })?.type === 'mouseReleased',
    );
    expect(releasedCalls).toHaveLength(1);
    expect(releasedCalls[0][2]).toMatchObject({
      type: 'mouseReleased',
      x: 100,
      y: 200,
      button: 'left',
      clickCount: 1,
    });

    // mousePressed comes before mouseReleased
    const pressedIndex = sendCalls.indexOf(pressedCalls[0]);
    const releasedIndex = sendCalls.indexOf(releasedCalls[0]);
    expect(pressedIndex).toBeLessThan(releasedIndex);
  });

  it('moves mouse before clicking (sends mouseMoved events)', async () => {
    const cdp = createMockCDP();
    const rng = createPRNG('click-move-test');
    const tabId = 1;

    const clickPromise = humanizedClick(cdp, tabId, rng, 100, 200);
    await flushTimers();
    await clickPromise;

    const sendCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls;
    const movedCalls = sendCalls.filter(
      (c: unknown[]) => (c[2] as { type: string })?.type === 'mouseMoved',
    );

    // Should have multiple mouseMoved events (from the Bezier curve)
    expect(movedCalls.length).toBeGreaterThan(5);

    // First CDP call should be a mouseMoved
    expect((sendCalls[0][2] as { type: string }).type).toBe('mouseMoved');
  });
});

describe('humanizedType', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('sends keyDown/keyUp for each character', async () => {
    const cdp = createMockCDP();
    // Use a seed that we know won't trigger typos for 'abc'
    // We'll just verify the correct characters appear
    const rng = createPRNG('type-test');
    const tabId = 1;

    const typePromise = humanizedType(cdp, tabId, rng, 'abc');
    await flushTimers();
    await typePromise;

    const sendCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls;

    // Extract key events
    const keyDownCalls = sendCalls.filter(
      (c: unknown[]) => (c[2] as { type: string })?.type === 'keyDown',
    );
    const keyUpCalls = sendCalls.filter(
      (c: unknown[]) => (c[2] as { type: string })?.type === 'keyUp',
    );

    // At minimum, 3 keyDown + 3 keyUp for 'abc' (more if typos occurred)
    expect(keyDownCalls.length).toBeGreaterThanOrEqual(3);
    expect(keyUpCalls.length).toBeGreaterThanOrEqual(3);

    // The correct characters 'a', 'b', 'c' should all appear in keyDown events
    const keyDownTexts = keyDownCalls
      .map((c: unknown[]) => (c[2] as { text?: string }).text)
      .filter(Boolean);
    expect(keyDownTexts).toContain('a');
    expect(keyDownTexts).toContain('b');
    expect(keyDownTexts).toContain('c');
  });

  it('all CDP calls target the correct tab', async () => {
    const cdp = createMockCDP();
    const rng = createPRNG('type-tab-test');
    const tabId = 42;

    const typePromise = humanizedType(cdp, tabId, rng, 'hi');
    await flushTimers();
    await typePromise;

    const sendCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of sendCalls) {
      expect(call[0]).toBe(42);
    }
  });

  it('sends pairs of keyDown/keyUp for each keystroke', async () => {
    const cdp = createMockCDP();
    const rng = createPRNG('type-pairs-test');
    const tabId = 1;

    const typePromise = humanizedType(cdp, tabId, rng, 'x');
    await flushTimers();
    await typePromise;

    const sendCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls;

    // For a single character (assuming no typo), we get keyDown then keyUp
    const types = sendCalls.map((c: unknown[]) => (c[2] as { type: string }).type);

    // The correct character's keyDown should come before its keyUp
    const lastKeyDown = types.lastIndexOf('keyDown');
    const lastKeyUp = types.lastIndexOf('keyUp');
    // keyDown for the correct char comes before keyUp
    expect(lastKeyDown).toBeLessThan(lastKeyUp);
  });
});

describe('humanizedScroll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('sends mouseWheel events', async () => {
    const cdp = createMockCDP(100, 200);
    const rng = createPRNG('scroll-test');
    const tabId = 1;

    const scrollPromise = humanizedScroll(cdp, tabId, rng, 500);
    await flushTimers();
    await scrollPromise;

    const sendCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls;
    const wheelCalls = sendCalls.filter(
      (c: unknown[]) => (c[2] as { type: string })?.type === 'mouseWheel',
    );

    // deltaY=500 => scrollSteps = max(3, abs(round(500/100))) = 5
    expect(wheelCalls.length).toBe(5);

    // Each wheel event should use current mouse position
    for (const call of wheelCalls) {
      expect(call[2]).toMatchObject({
        type: 'mouseWheel',
        x: 100,
        y: 200,
        deltaX: 0,
      });
      // deltaY should be positive (scrolling down)
      expect((call[2] as { deltaY: number }).deltaY).toBeGreaterThan(0);
    }
  });

  it('sends at least 3 scroll steps even for small deltaY', async () => {
    const cdp = createMockCDP();
    const rng = createPRNG('scroll-small');
    const tabId = 1;

    const scrollPromise = humanizedScroll(cdp, tabId, rng, 50);
    await flushTimers();
    await scrollPromise;

    const sendCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls;
    const wheelCalls = sendCalls.filter(
      (c: unknown[]) => (c[2] as { type: string })?.type === 'mouseWheel',
    );

    // min 3 steps
    expect(wheelCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('applies momentum (later steps have smaller deltaY)', async () => {
    const cdp = createMockCDP();
    const rng = createPRNG('scroll-momentum');
    const tabId = 1;

    const scrollPromise = humanizedScroll(cdp, tabId, rng, 1000);
    await flushTimers();
    await scrollPromise;

    const sendCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls;
    const wheelCalls = sendCalls.filter(
      (c: unknown[]) => (c[2] as { type: string })?.type === 'mouseWheel',
    );

    const deltas = wheelCalls.map((c: unknown[]) => (c[2] as { deltaY: number }).deltaY);

    // First delta should be larger than last delta (momentum decay)
    expect(Math.abs(deltas[0])).toBeGreaterThan(Math.abs(deltas[deltas.length - 1]));
  });
});

describe('humanizedMouseMove', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('updates mouse position on CDPManager', async () => {
    const cdp = createMockCDP(0, 0);
    const rng = createPRNG('move-test');
    const tabId = 1;

    const movePromise = humanizedMouseMove(cdp, tabId, rng, 300, 400);
    await flushTimers();
    await movePromise;

    expect(cdp.setMousePosition).toHaveBeenCalledWith(tabId, 300, 400);
  });

  it('sends mouseMoved events along the path', async () => {
    const cdp = createMockCDP(10, 20);
    const rng = createPRNG('move-path-test');
    const tabId = 1;

    const movePromise = humanizedMouseMove(cdp, tabId, rng, 200, 300);
    await flushTimers();
    await movePromise;

    const sendCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls;
    const movedCalls = sendCalls.filter(
      (c: unknown[]) => (c[2] as { type: string })?.type === 'mouseMoved',
    );

    // Between 21 and 51 points (randomInt(rng, 20, 50) steps + 1)
    expect(movedCalls.length).toBeGreaterThanOrEqual(21);
    expect(movedCalls.length).toBeLessThanOrEqual(51);

    // All calls should target the correct tab and method
    for (const call of movedCalls) {
      expect(call[0]).toBe(tabId);
      expect(call[1]).toBe('Input.dispatchMouseEvent');
    }
  });

  it('first mouseMoved starts near origin, last ends near target', async () => {
    const cdp = createMockCDP(0, 0);
    const rng = createPRNG('move-endpoints');
    const tabId = 1;

    const movePromise = humanizedMouseMove(cdp, tabId, rng, 500, 500);
    await flushTimers();
    await movePromise;

    const sendCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls;
    const movedCalls = sendCalls.filter(
      (c: unknown[]) => (c[2] as { type: string })?.type === 'mouseMoved',
    );

    const first = movedCalls[0][2] as { x: number; y: number };
    const last = movedCalls[movedCalls.length - 1][2] as { x: number; y: number };

    // First point should be at origin (0, 0)
    expect(first.x).toBe(0);
    expect(first.y).toBe(0);

    // Last point should be at target (500, 500)
    expect(last.x).toBe(500);
    expect(last.y).toBe(500);
  });
});
