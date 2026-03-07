import { describe, it, expect, vi } from 'vitest';
import { CDPManager } from './cdp';
import {
  resolveSelector,
  resolveA11ySelector,
  SelectorNotFoundError,
} from './selector-resolver';

function createMockCDP() {
  const cdp = {
    send: vi.fn(),
  } as unknown as CDPManager;
  return cdp;
}

describe('resolveSelector', () => {
  it('resolves a CSS selector and returns element position', async () => {
    const cdp = createMockCDP();
    const send = vi.mocked(cdp.send);

    // DOM.getDocument
    send.mockResolvedValueOnce({ root: { nodeId: 1 } });
    // DOM.querySelector
    send.mockResolvedValueOnce({ nodeId: 42 });
    // DOM.scrollIntoViewIfNeeded
    send.mockResolvedValueOnce(undefined);
    // DOM.getContentQuads — quad is [x1,y1, x2,y2, x3,y3, x4,y4]
    send.mockResolvedValueOnce({
      quads: [[100, 200, 300, 200, 300, 400, 100, 400]],
    });

    const result = await resolveSelector(cdp, 1, 'button.submit');

    expect(result.nodeId).toBe(42);
    expect(result.bounds).toEqual({ x: 100, y: 200, width: 200, height: 200 });
    expect(result.centerX).toBe(200);
    expect(result.centerY).toBe(300);

    expect(send).toHaveBeenCalledWith(1, 'DOM.getDocument', {
      depth: 0,
      pierce: true,
    });
    expect(send).toHaveBeenCalledWith(1, 'DOM.querySelector', {
      nodeId: 1,
      selector: 'button.submit',
    });
    expect(send).toHaveBeenCalledWith(1, 'DOM.scrollIntoViewIfNeeded', {
      nodeId: 42,
    });
    expect(send).toHaveBeenCalledWith(1, 'DOM.getContentQuads', {
      nodeId: 42,
    });
  });

  it('throws SelectorNotFoundError when nodeId is 0', async () => {
    const cdp = createMockCDP();
    const send = vi.mocked(cdp.send);

    send.mockResolvedValueOnce({ root: { nodeId: 1 } });
    send.mockResolvedValueOnce({ nodeId: 0 });

    const err = await resolveSelector(cdp, 1, '.missing').catch((e) => e);
    expect(err).toBeInstanceOf(SelectorNotFoundError);
    expect(err.message).toBe('Selector not found: .missing');
  });

  it('throws SelectorNotFoundError when no quads returned', async () => {
    const cdp = createMockCDP();
    const send = vi.mocked(cdp.send);

    send.mockResolvedValueOnce({ root: { nodeId: 1 } });
    send.mockResolvedValueOnce({ nodeId: 10 });
    send.mockResolvedValueOnce(undefined);
    send.mockResolvedValueOnce({ quads: [] });

    const err = await resolveSelector(cdp, 1, '.invisible').catch((e) => e);
    expect(err).toBeInstanceOf(SelectorNotFoundError);
    expect(err.message).toBe('Element has no visual bounds: .invisible');
  });

  it('calculates correct center and bounds from non-rectangular quad', async () => {
    const cdp = createMockCDP();
    const send = vi.mocked(cdp.send);

    // A non-axis-aligned quad (trapezoid-like)
    // corners: (10,20), (50,10), (60,40), (5,50)
    send.mockResolvedValueOnce({ root: { nodeId: 1 } });
    send.mockResolvedValueOnce({ nodeId: 7 });
    send.mockResolvedValueOnce(undefined);
    send.mockResolvedValueOnce({
      quads: [[10, 20, 50, 10, 60, 40, 5, 50]],
    });

    const result = await resolveSelector(cdp, 1, 'div.skewed');

    // xs: [10, 50, 60, 5] => min=5, max=60 => width=55
    // ys: [20, 10, 40, 50] => min=10, max=50 => height=40
    expect(result.bounds).toEqual({ x: 5, y: 10, width: 55, height: 40 });
    expect(result.centerX).toBe(5 + 55 / 2); // 32.5
    expect(result.centerY).toBe(10 + 40 / 2); // 30
  });
});

describe('resolveA11ySelector', () => {
  it('resolves role+name via Accessibility.queryAXTree', async () => {
    const cdp = createMockCDP();
    const send = vi.mocked(cdp.send);

    // DOM.getDocument
    send.mockResolvedValueOnce({ root: { nodeId: 1 } });
    // Accessibility.queryAXTree
    send.mockResolvedValueOnce({
      nodes: [{ backendDOMNodeId: 99 }],
    });
    // DOM.resolveNode
    send.mockResolvedValueOnce({ object: { objectId: 'obj-1' } });
    // DOM.requestNode
    send.mockResolvedValueOnce({ nodeId: 55 });
    // DOM.scrollIntoViewIfNeeded
    send.mockResolvedValueOnce(undefined);
    // DOM.getContentQuads
    send.mockResolvedValueOnce({
      quads: [[0, 0, 120, 0, 120, 40, 0, 40]],
    });

    const result = await resolveA11ySelector(cdp, 1, 'button', 'Submit');

    expect(result.nodeId).toBe(55);
    expect(result.bounds).toEqual({ x: 0, y: 0, width: 120, height: 40 });
    expect(result.centerX).toBe(60);
    expect(result.centerY).toBe(20);

    expect(send).toHaveBeenCalledWith(1, 'Accessibility.queryAXTree', {
      nodeId: 1,
      role: 'button',
      name: 'Submit',
    });
    expect(send).toHaveBeenCalledWith(1, 'DOM.resolveNode', {
      backendNodeId: 99,
    });
    expect(send).toHaveBeenCalledWith(1, 'DOM.requestNode', {
      objectId: 'obj-1',
    });
  });

  it('throws SelectorNotFoundError when no AX nodes found', async () => {
    const cdp = createMockCDP();
    const send = vi.mocked(cdp.send);

    send.mockResolvedValueOnce({ root: { nodeId: 1 } });
    send.mockResolvedValueOnce({ nodes: [] });

    const err = await resolveA11ySelector(cdp, 1, 'button', 'Nonexistent').catch((e) => e);
    expect(err).toBeInstanceOf(SelectorNotFoundError);
    expect(err.message).toBe('A11y selector not found: role="button" name="Nonexistent"');
  });

  it('builds correct description with role only', async () => {
    const cdp = createMockCDP();
    const send = vi.mocked(cdp.send);

    send.mockResolvedValueOnce({ root: { nodeId: 1 } });
    send.mockResolvedValueOnce({ nodes: [] });

    await expect(
      resolveA11ySelector(cdp, 1, 'heading', undefined),
    ).rejects.toThrow('A11y selector not found: role="heading"');
  });

  it('builds correct description with name only', async () => {
    const cdp = createMockCDP();
    const send = vi.mocked(cdp.send);

    send.mockResolvedValueOnce({ root: { nodeId: 1 } });
    send.mockResolvedValueOnce({ nodes: [] });

    await expect(
      resolveA11ySelector(cdp, 1, undefined, 'Submit'),
    ).rejects.toThrow('A11y selector not found: name="Submit"');
  });

  it('throws SelectorNotFoundError when a11y element has no visual bounds', async () => {
    const cdp = createMockCDP();
    const send = vi.mocked(cdp.send);

    send.mockResolvedValueOnce({ root: { nodeId: 1 } });
    send.mockResolvedValueOnce({
      nodes: [{ backendDOMNodeId: 99 }],
    });
    send.mockResolvedValueOnce({ object: { objectId: 'obj-1' } });
    send.mockResolvedValueOnce({ nodeId: 55 });
    send.mockResolvedValueOnce(undefined);
    send.mockResolvedValueOnce({ quads: [] });

    const err = await resolveA11ySelector(cdp, 1, 'button', 'Hidden').catch((e) => e);
    expect(err).toBeInstanceOf(SelectorNotFoundError);
    expect(err.message).toBe('A11y element has no visual bounds');
  });
});

describe('SelectorNotFoundError', () => {
  it('has correct name and message', () => {
    const err = new SelectorNotFoundError('test message');
    expect(err.name).toBe('SelectorNotFoundError');
    expect(err.message).toBe('test message');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SelectorNotFoundError);
  });
});
