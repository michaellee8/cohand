// src/lib/humanized-page-handler.ts
import type { ScriptRPC } from '../types';
import type { CDPManager } from './cdp';
import { CDPNavigationError } from './cdp';
import {
  resolveSelector,
  resolveA11ySelector,
  SelectorNotFoundError,
} from './selector-resolver';
import {
  humanizedClick,
  humanizedType,
  humanizedScroll,
} from './humanize';
import { createPRNG, randomInRange } from './prng';
import { isDomainAllowed, isSensitivePage } from './security/domain-guard';
import { MAX_TEXT_CONTENT_LENGTH, MAX_CUMULATIVE_READS } from '../constants';
import { RPCHandler, type RPCMethodHandler } from './rpc-handler';

export interface HandlerContext {
  cdp: CDPManager;
  getAllowedDomains: (taskId: string) => Promise<string[]>;
  getTabUrl: (tabId: number) => Promise<string>;
  getTabId: (taskId: string) => number | undefined;
}

/**
 * Track cumulative bytes read per task execution.
 */
const cumulativeReads = new Map<string, number>();

export function resetCumulativeReads(taskId: string): void {
  cumulativeReads.delete(taskId);
}

export function getCumulativeReads(taskId: string): number {
  return cumulativeReads.get(taskId) ?? 0;
}

export class CumulativeReadLimitError extends Error {
  constructor(taskId: string, total: number) {
    super(`Task ${taskId} exceeded cumulative read limit: ${total} bytes`);
    this.name = 'CumulativeReadLimitError';
  }
}

function trackRead(taskId: string, bytes: number): void {
  const current = cumulativeReads.get(taskId) ?? 0;
  const newTotal = current + bytes;
  cumulativeReads.set(taskId, newTotal);
  if (newTotal > MAX_CUMULATIVE_READS) {
    throw new CumulativeReadLimitError(taskId, newTotal);
  }
}

const ALLOWED_ATTRIBUTES = [
  'href',
  'aria-label',
  'role',
  'title',
  'alt',
  'data-testid',
];

/**
 * Register all HumanizedPage RPC methods on the RPCHandler.
 */
export function registerPageMethods(
  handler: RPCHandler,
  ctx: HandlerContext,
): void {
  const makeHandler = (
    fn: (rpc: ScriptRPC, ctx: HandlerContext) => Promise<unknown>,
  ): RPCMethodHandler => {
    return async (rpc) => {
      // Validate tab exists
      const tabId = ctx.getTabId(rpc.taskId);
      if (tabId === undefined) {
        return {
          ok: false,
          error: { type: 'TargetDetached', message: 'No tab for task' },
        };
      }

      try {
        const tabUrl = await ctx.getTabUrl(tabId);
        const allowedDomains = await ctx.getAllowedDomains(rpc.taskId);
        if (!isDomainAllowed(tabUrl, allowedDomains)) {
          return {
            ok: false,
            error: {
              type: 'DomainDisallowed',
              message: `Domain not allowed: ${tabUrl}`,
            },
          };
        }
        if (isSensitivePage(tabUrl)) {
          return {
            ok: false,
            error: {
              type: 'SensitivePage',
              message: `Blocked: sensitive page detected: ${tabUrl}`,
            },
          };
        }

        const value = await fn(rpc, ctx);
        return { ok: true, value };
      } catch (err: unknown) {
        if (err instanceof SelectorNotFoundError) {
          return {
            ok: false,
            error: { type: 'SelectorNotFound', message: err.message },
          };
        }
        if (err instanceof CDPNavigationError) {
          return {
            ok: false,
            error: { type: 'NavigationChanged', message: err.message },
          };
        }
        if (err instanceof CumulativeReadLimitError) {
          return {
            ok: false,
            error: { type: 'ReadLimitExceeded', message: err.message },
          };
        }
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: { type: 'TargetDetached', message },
        };
      }
    };
  };

  // goto
  handler.register(
    'goto',
    makeHandler(async (rpc, ctx) => {
      const [url] = rpc.args.args as [string];
      const tabId = ctx.getTabId(rpc.taskId)!;

      // Block dangerous URL schemes
      const BLOCKED_GOTO_SCHEMES = ['javascript:', 'data:', 'file:', 'blob:', 'vbscript:'];
      try {
        const parsed = new URL(url);
        if (BLOCKED_GOTO_SCHEMES.some(s => parsed.protocol === s)) {
          throw new Error(`Navigation to ${parsed.protocol} URLs is blocked`);
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('blocked')) throw e;
        // URL parsing failed — check prefix directly
        const lower = url.toLowerCase().trim();
        if (BLOCKED_GOTO_SCHEMES.some(s => lower.startsWith(s))) {
          throw new Error(`Navigation to dangerous URL scheme is blocked`);
        }
      }

      // Validate target URL domain
      const allowedDomains = await ctx.getAllowedDomains(rpc.taskId);
      if (!isDomainAllowed(url, allowedDomains)) {
        throw new Error(`Navigation to disallowed domain: ${url}`);
      }

      await ctx.cdp.send(tabId, 'Page.navigate', { url });
      // Wait for load
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return undefined;
    }),
  );

  // click
  handler.register(
    'click',
    makeHandler(async (rpc, ctx) => {
      const [selector] = rpc.args.args as [string];
      const tabId = ctx.getTabId(rpc.taskId)!;
      const rng = createPRNG(`${rpc.taskId}:${rpc.id}`);

      const element = await resolveSelector(ctx.cdp, tabId, selector);

      // Random offset within element bounds (30%-70%)
      const targetX =
        element.bounds.x +
        randomInRange(rng, 0.3, 0.7) * element.bounds.width;
      const targetY =
        element.bounds.y +
        randomInRange(rng, 0.3, 0.7) * element.bounds.height;

      await humanizedClick(ctx.cdp, tabId, rng, targetX, targetY);
      return undefined;
    }),
  );

  // fill (click + select all + type)
  handler.register(
    'fill',
    makeHandler(async (rpc, ctx) => {
      const [selector, text] = rpc.args.args as [string, string];
      const tabId = ctx.getTabId(rpc.taskId)!;
      const rng = createPRNG(`${rpc.taskId}:${rpc.id}`);

      const element = await resolveSelector(ctx.cdp, tabId, selector);
      const targetX =
        element.bounds.x +
        randomInRange(rng, 0.3, 0.7) * element.bounds.width;
      const targetY =
        element.bounds.y +
        randomInRange(rng, 0.3, 0.7) * element.bounds.height;

      // Click to focus
      await humanizedClick(ctx.cdp, tabId, rng, targetX, targetY);

      // Select all existing content
      await ctx.cdp.send(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        modifiers: 2, // Ctrl
      });
      await ctx.cdp.send(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        modifiers: 2,
      });

      // Type new text
      await humanizedType(ctx.cdp, tabId, rng, text);
      return undefined;
    }),
  );

  // type (append, no select all)
  handler.register(
    'type',
    makeHandler(async (rpc, ctx) => {
      const [selector, text] = rpc.args.args as [string, string];
      const tabId = ctx.getTabId(rpc.taskId)!;
      const rng = createPRNG(`${rpc.taskId}:${rpc.id}`);

      const element = await resolveSelector(ctx.cdp, tabId, selector);
      const targetX =
        element.bounds.x +
        randomInRange(rng, 0.3, 0.7) * element.bounds.width;
      const targetY =
        element.bounds.y +
        randomInRange(rng, 0.3, 0.7) * element.bounds.height;

      await humanizedClick(ctx.cdp, tabId, rng, targetX, targetY);
      await humanizedType(ctx.cdp, tabId, rng, text);
      return undefined;
    }),
  );

  // scroll
  handler.register(
    'scroll',
    makeHandler(async (rpc, ctx) => {
      const [distance] = rpc.args.args as [number];
      const tabId = ctx.getTabId(rpc.taskId)!;
      const rng = createPRNG(`${rpc.taskId}:${rpc.id}`);
      await humanizedScroll(ctx.cdp, tabId, rng, distance);
      return undefined;
    }),
  );

  // waitForSelector
  handler.register(
    'waitForSelector',
    makeHandler(async (rpc, ctx) => {
      const [selector, opts] = rpc.args.args as [
        string,
        { timeout?: number }?,
      ];
      const tabId = ctx.getTabId(rpc.taskId)!;
      const timeout = opts?.timeout ?? 30000;
      const start = Date.now();

      while (Date.now() - start < timeout) {
        // Check if task is still active
        if (ctx.getTabId(rpc.taskId) === undefined) {
          throw new Error('Task execution cancelled');
        }
        try {
          await resolveSelector(ctx.cdp, tabId, selector);
          return undefined;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      throw new SelectorNotFoundError(`Timeout waiting for: ${selector}`);
    }),
  );

  // waitForLoadState
  handler.register(
    'waitForLoadState',
    makeHandler(async (rpc, ctx) => {
      const tabId = ctx.getTabId(rpc.taskId)!;
      const timeout = 10000; // 10 seconds max
      const start = Date.now();

      // Poll page load state via CDP
      while (Date.now() - start < timeout) {
        try {
          const metrics = (await ctx.cdp.send(tabId, 'Page.getLayoutMetrics')) as Record<string, unknown>;
          if (metrics) return undefined; // Page is responsive
        } catch {
          // Page still loading — wait and retry
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return undefined;
    }),
  );

  // url
  handler.register(
    'url',
    makeHandler(async (rpc, ctx) => {
      const tabId = ctx.getTabId(rpc.taskId)!;
      return ctx.getTabUrl(tabId);
    }),
  );

  // title
  handler.register(
    'title',
    makeHandler(async (rpc, ctx) => {
      const tabId = ctx.getTabId(rpc.taskId)!;
      const result = (await ctx.cdp.send(tabId, 'Runtime.evaluate', {
        expression: 'document.title',
      })) as { result?: { value?: string } } | undefined;
      return result?.result?.value ?? '';
    }),
  );

  // locator_action -- handles all locator method calls
  handler.register(
    'locator_action',
    makeHandler(async (rpc, ctx) => {
      const { locatorMethod, locatorArgs, actionMethod, actionArgs } =
        rpc.args as {
          locatorMethod: string;
          locatorArgs: unknown[];
          actionMethod: string;
          actionArgs: unknown[];
        };
      const tabId = ctx.getTabId(rpc.taskId)!;
      const rng = createPRNG(`${rpc.taskId}:${rpc.id}`);

      // Resolve the locator to an element
      let element;
      if (locatorMethod === 'locator') {
        element = await resolveSelector(
          ctx.cdp,
          tabId,
          locatorArgs[0] as string,
        );
      } else if (locatorMethod === 'getByRole') {
        element = await resolveA11ySelector(
          ctx.cdp,
          tabId,
          locatorArgs[0] as string,
          locatorArgs[1] as string | undefined,
        );
      } else if (
        locatorMethod === 'getByText' ||
        locatorMethod === 'getByLabel'
      ) {
        element = await resolveA11ySelector(
          ctx.cdp,
          tabId,
          undefined,
          locatorArgs[0] as string,
        );
      } else {
        throw new Error(`Unknown locator method: ${locatorMethod}`);
      }

      // Execute the action
      switch (actionMethod) {
        case 'click': {
          const targetX =
            element.bounds.x +
            randomInRange(rng, 0.3, 0.7) * element.bounds.width;
          const targetY =
            element.bounds.y +
            randomInRange(rng, 0.3, 0.7) * element.bounds.height;
          await humanizedClick(ctx.cdp, tabId, rng, targetX, targetY);
          return undefined;
        }
        case 'fill': {
          const [text] = actionArgs as [string];
          const targetX =
            element.bounds.x +
            randomInRange(rng, 0.3, 0.7) * element.bounds.width;
          const targetY =
            element.bounds.y +
            randomInRange(rng, 0.3, 0.7) * element.bounds.height;
          await humanizedClick(ctx.cdp, tabId, rng, targetX, targetY);
          await humanizedType(ctx.cdp, tabId, rng, text);
          return undefined;
        }
        case 'type': {
          const [text] = actionArgs as [string];
          const targetX =
            element.bounds.x +
            randomInRange(rng, 0.3, 0.7) * element.bounds.width;
          const targetY =
            element.bounds.y +
            randomInRange(rng, 0.3, 0.7) * element.bounds.height;
          await humanizedClick(ctx.cdp, tabId, rng, targetX, targetY);
          await humanizedType(ctx.cdp, tabId, rng, text);
          return undefined;
        }
        case 'textContent': {
          const result = (await ctx.cdp.send(tabId, 'DOM.getOuterHTML', {
            nodeId: element.nodeId,
          })) as { outerHTML?: string } | undefined;
          const text = (result?.outerHTML ?? '')
            .replace(/<[^>]*>/g, '')
            .slice(0, MAX_TEXT_CONTENT_LENGTH);
          trackRead(rpc.taskId, text.length);
          return text;
        }
        case 'getAttribute': {
          const [attrName] = actionArgs as [string];
          if (!ALLOWED_ATTRIBUTES.includes(attrName)) {
            throw new Error(`Attribute not in whitelist: ${attrName}`);
          }
          const result = (await ctx.cdp.send(tabId, 'DOM.getAttributes', {
            nodeId: element.nodeId,
          })) as { attributes?: string[] } | undefined;
          const attrs = result?.attributes ?? [];
          for (let i = 0; i < attrs.length; i += 2) {
            if (attrs[i] === attrName) {
              const value = String(attrs[i + 1]).slice(
                0,
                MAX_TEXT_CONTENT_LENGTH,
              );
              trackRead(rpc.taskId, value.length);
              return value;
            }
          }
          return null;
        }
        case 'boundingBox':
          return element.bounds;
        case 'isVisible':
          return element.bounds.width > 0 && element.bounds.height > 0;
        case 'count': {
          // For count, re-query to get all matches
          if (locatorMethod === 'locator') {
            const doc = (await ctx.cdp.send(tabId, 'DOM.getDocument', {
              depth: 0,
              pierce: true,
            })) as { root: { nodeId: number } };
            const all = (await ctx.cdp.send(
              tabId,
              'DOM.querySelectorAll',
              {
                nodeId: doc.root.nodeId,
                selector: locatorArgs[0],
              },
            )) as { nodeIds?: number[] } | undefined;
            return all?.nodeIds?.length ?? 0;
          }
          return 1; // AX selectors don't support count easily
        }
        case 'all': {
          // Return array of locator proxies (represented as indexes)
          // For CSS selectors, query all matching elements and return count
          // The script-side proxy handles creating sub-locators
          if (locatorMethod === 'locator') {
            const doc = (await ctx.cdp.send(tabId, 'DOM.getDocument', {
              depth: 0,
              pierce: true,
            })) as { root: { nodeId: number } };
            const allNodes = (await ctx.cdp.send(
              tabId,
              'DOM.querySelectorAll',
              {
                nodeId: doc.root.nodeId,
                selector: locatorArgs[0],
              },
            )) as { nodeIds?: number[] } | undefined;
            const count = allNodes?.nodeIds?.length ?? 0;
            return Array.from({ length: count }, (_, i) => i);
          }
          return [0]; // AX selectors return single match
        }
        default:
          throw new Error(`Unknown locator action: ${actionMethod}`);
      }
    }),
  );

  // notify -- special method, not a page action.
  // TODO: Wire to actual notification delivery (deliverNotification in notifications.ts).
  // Currently a stub that acknowledges the notification without persisting it.
  // Registered directly (no makeHandler) because notify doesn't interact with
  // the page and should not require domain validation.
  handler.register('notify', async (rpc) => {
    return {
      ok: true,
      value: {
        queued: true,
        message: (rpc.args as { message?: string }).message,
      },
    };
  });
}
