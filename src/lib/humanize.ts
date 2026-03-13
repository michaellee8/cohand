// src/lib/humanize.ts

import { CDPManager } from './cdp';
import { randomInRange, randomInt } from './prng';

/**
 * Generate points along a cubic Bezier curve from start to end.
 * Control points are randomly offset for natural-looking mouse movement.
 */
export function generateBezierCurve(
  rng: () => number,
  startX: number, startY: number,
  endX: number, endY: number,
  steps: number,
): Array<{ x: number; y: number }> {
  // Random control points offset from the straight line
  const dx = endX - startX;
  const dy = endY - startY;

  const cp1x = startX + dx * randomInRange(rng, 0.2, 0.4) + randomInRange(rng, -50, 50);
  const cp1y = startY + dy * randomInRange(rng, 0.2, 0.4) + randomInRange(rng, -50, 50);
  const cp2x = startX + dx * randomInRange(rng, 0.6, 0.8) + randomInRange(rng, -30, 30);
  const cp2y = startY + dy * randomInRange(rng, 0.6, 0.8) + randomInRange(rng, -30, 30);

  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;

    const x = u * u * u * startX + 3 * u * u * t * cp1x + 3 * u * t * t * cp2x + t * t * t * endX;
    const y = u * u * u * startY + 3 * u * u * t * cp1y + 3 * u * t * t * cp2y + t * t * t * endY;

    points.push({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 });
  }

  return points;
}

/**
 * Move mouse along a Bezier curve to target position using CDP Input events.
 */
export async function humanizedMouseMove(
  cdp: CDPManager,
  tabId: number,
  rng: () => number,
  targetX: number,
  targetY: number,
): Promise<void> {
  const { x: startX, y: startY } = cdp.getMousePosition(tabId);
  const steps = randomInt(rng, 20, 50);
  const points = generateBezierCurve(rng, startX, startY, targetX, targetY, steps);

  for (const point of points) {
    await cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    });
    // Small delay between points (2-8ms)
    await delay(randomInt(rng, 2, 8));
  }

  cdp.setMousePosition(tabId, targetX, targetY);
}

/**
 * Humanized click: Bezier mouse move -> hover delay -> mousePressed -> pause -> mouseReleased.
 */
export async function humanizedClick(
  cdp: CDPManager,
  tabId: number,
  rng: () => number,
  targetX: number,
  targetY: number,
): Promise<void> {
  // Random offset within element (30%-70% range applied by caller)
  await humanizedMouseMove(cdp, tabId, rng, targetX, targetY);

  // Pre-click hover delay
  await delay(randomInt(rng, 100, 300));

  // Mouse down
  await cdp.send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: targetX,
    y: targetY,
    button: 'left',
    clickCount: 1,
  });

  try {
    // Random press duration
    await delay(randomInt(rng, 50, 150));
  } finally {
    // Compensating mouseReleased — always sent even if an error occurs
    // between mousePressed and mouseReleased to prevent stuck mouse state.
    // Swallow errors in finally (tab may have been closed).
    try {
      await cdp.send(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: targetX,
        y: targetY,
        button: 'left',
        clickCount: 1,
      });
    } catch {
      // Tab may be closed — swallow to avoid masking the original error
    }
  }
}

/**
 * Humanized typing: variable keystroke timing, occasional typos with backspace.
 */
export async function humanizedType(
  cdp: CDPManager,
  tabId: number,
  rng: () => number,
  text: string,
): Promise<void> {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // 3% typo chance
    if (rng() < 0.03 && i < text.length - 1) {
      // Type wrong character
      const typoChar = String.fromCharCode(char.charCodeAt(0) + randomInt(rng, 1, 3));
      await cdp.send(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: typoChar,
      });
      await cdp.send(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        text: typoChar,
      });
      await delay(randomInt(rng, 50, 150));

      // Backspace to correct
      await cdp.send(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Backspace',
        code: 'Backspace',
      });
      await cdp.send(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Backspace',
        code: 'Backspace',
      });
      await delay(randomInt(rng, 100, 300));
    }

    // Type correct character
    await cdp.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: char,
    });
    await cdp.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      text: char,
    });

    // Variable delay between keystrokes (40-200ms)
    await delay(randomInt(rng, 40, 200));

    // Occasional thinking pause (5% chance, 500-1500ms)
    if (rng() < 0.05) {
      await delay(randomInt(rng, 500, 1500));
    }
  }
}

/**
 * Humanized scroll: momentum simulation with reading pauses.
 */
export async function humanizedScroll(
  cdp: CDPManager,
  tabId: number,
  rng: () => number,
  deltaY: number,
): Promise<void> {
  const { x, y } = cdp.getMousePosition(tabId);
  const scrollSteps = Math.max(3, Math.abs(Math.round(deltaY / 100)));
  const stepSize = deltaY / scrollSteps;

  for (let i = 0; i < scrollSteps; i++) {
    // Momentum: start fast, slow down
    const momentum = 1 - (i / scrollSteps) * 0.5;
    const currentStep = stepSize * momentum;

    await cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY: currentStep,
    });

    await delay(randomInt(rng, 30, 80));

    // 15% chance of reading pause (1-4s)
    if (rng() < 0.15) {
      await delay(randomInt(rng, 1000, 4000));
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
