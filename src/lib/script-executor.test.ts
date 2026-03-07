import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeScript, type HostCallFn } from './script-executor';

describe('executeScript', () => {
  const mockHostCall: HostCallFn = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes a simple script and returns result', async () => {
    const source = `
      async function run(page, context) {
        return { hello: 'world' };
      }
    `;
    const result = await executeScript(source, 'task-1', mockHostCall, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ hello: 'world' });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('passes initial state to context', async () => {
    const source = `
      async function run(page, context) {
        return { value: context.state.count };
      }
    `;
    const result = await executeScript(source, 'task-1', mockHostCall, { count: 42 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result).toEqual({ value: 42 });
  });

  it('returns updated state', async () => {
    const source = `
      async function run(page, context) {
        context.state.updated = true;
        return {};
      }
    `;
    const result = await executeScript(source, 'task-1', mockHostCall, {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.updated).toBe(true);
  });

  it('calls host function for page methods', async () => {
    const hostCall = vi.fn().mockResolvedValue('https://example.com');
    const source = `
      async function run(page, context) {
        await page.goto('https://example.com');
        await page.click('#btn');
        return {};
      }
    `;
    await executeScript(source, 'task-1', hostCall, {});
    expect(hostCall).toHaveBeenCalledWith('goto', expect.objectContaining({ args: ['https://example.com'] }));
    expect(hostCall).toHaveBeenCalledWith('click', expect.objectContaining({ args: ['#btn'] }));
  });

  it('calls host function for locator methods', async () => {
    const hostCall = vi.fn().mockResolvedValue('$24.99');
    const source = `
      async function run(page, context) {
        const text = await page.locator('.price').textContent();
        return { price: text };
      }
    `;
    const result = await executeScript(source, 'task-1', hostCall, {});
    expect(hostCall).toHaveBeenCalledWith('locator_action', expect.objectContaining({
      locatorMethod: 'locator',
      locatorArgs: ['.price'],
      actionMethod: 'textContent',
    }));
  });

  it('calls host function for getByRole locator', async () => {
    const hostCall = vi.fn().mockResolvedValue(undefined);
    const source = `
      async function run(page, context) {
        await page.getByRole('button', { name: 'Submit' }).click();
        return {};
      }
    `;
    await executeScript(source, 'task-1', hostCall, {});
    expect(hostCall).toHaveBeenCalledWith('locator_action', expect.objectContaining({
      locatorMethod: 'getByRole',
      locatorArgs: ['button', { name: 'Submit' }],
      actionMethod: 'click',
    }));
  });

  it('calls host function for getByText locator', async () => {
    const hostCall = vi.fn().mockResolvedValue(true);
    const source = `
      async function run(page, context) {
        const visible = await page.getByText('Hello').isVisible();
        return { visible };
      }
    `;
    await executeScript(source, 'task-1', hostCall, {});
    expect(hostCall).toHaveBeenCalledWith('locator_action', expect.objectContaining({
      locatorMethod: 'getByText',
      locatorArgs: ['Hello'],
      actionMethod: 'isVisible',
    }));
  });

  it('calls host function for getByLabel locator', async () => {
    const hostCall = vi.fn().mockResolvedValue(undefined);
    const source = `
      async function run(page, context) {
        await page.getByLabel('Email').fill('test@example.com');
        return {};
      }
    `;
    await executeScript(source, 'task-1', hostCall, {});
    expect(hostCall).toHaveBeenCalledWith('locator_action', expect.objectContaining({
      locatorMethod: 'getByLabel',
      locatorArgs: ['Email'],
      actionMethod: 'fill',
      actionArgs: ['test@example.com'],
    }));
  });

  it('calls host function for notify', async () => {
    const hostCall = vi.fn().mockResolvedValue(undefined);
    const source = `
      async function run(page, context) {
        await context.notify('Price changed!');
        return {};
      }
    `;
    await executeScript(source, 'task-1', hostCall, {});
    expect(hostCall).toHaveBeenCalledWith('notify', expect.objectContaining({ message: 'Price changed!' }));
  });

  it('returns error for throwing scripts', async () => {
    const source = `
      async function run(page, context) {
        throw new Error('Something broke');
      }
    `;
    const result = await executeScript(source, 'task-1', mockHostCall, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Something broke');
  });

  it('returns error for syntax errors', async () => {
    const source = `function run( { invalid syntax`;
    const result = await executeScript(source, 'task-1', mockHostCall, {});
    expect(result.ok).toBe(false);
  });

  it('provides context.url', async () => {
    const source = `
      async function run(page, context) {
        return { url: context.url };
      }
    `;
    const result = await executeScript(source, 'task-1', mockHostCall, {}, 'https://example.com');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result).toEqual({ url: 'https://example.com' });
  });

  it('does not mutate initial state', async () => {
    const initialState = { count: 1 };
    const source = `
      async function run(page, context) {
        context.state.count = 99;
        return {};
      }
    `;
    await executeScript(source, 'task-1', mockHostCall, initialState);
    expect(initialState.count).toBe(1); // original unchanged
  });

  it('returns durationMs on error', async () => {
    const source = `
      async function run(page, context) {
        throw new Error('fail');
      }
    `;
    const result = await executeScript(source, 'task-1', mockHostCall, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('handles scripts without a run function', async () => {
    const source = `const x = 42;`;
    const result = await executeScript(source, 'task-1', mockHostCall, {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result).toBeUndefined();
  });

  it('passes taskId to host calls', async () => {
    const hostCall = vi.fn().mockResolvedValue(undefined);
    const source = `
      async function run(page, context) {
        await page.goto('https://example.com');
        return {};
      }
    `;
    await executeScript(source, 'task-abc', hostCall, {});
    expect(hostCall).toHaveBeenCalledWith('goto', expect.objectContaining({ taskId: 'task-abc' }));
  });

  it('passes taskId to notify host calls', async () => {
    const hostCall = vi.fn().mockResolvedValue(undefined);
    const source = `
      async function run(page, context) {
        await context.notify('hello');
        return {};
      }
    `;
    await executeScript(source, 'task-xyz', hostCall, {});
    expect(hostCall).toHaveBeenCalledWith('notify', expect.objectContaining({ taskId: 'task-xyz' }));
  });

  it('defaults context.url to empty string when not provided', async () => {
    const source = `
      async function run(page, context) {
        return { url: context.url };
      }
    `;
    const result = await executeScript(source, 'task-1', mockHostCall, {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result).toEqual({ url: '' });
  });
});
