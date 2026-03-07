// src/lib/selector-resolver.ts
import { CDPManager } from './cdp';

export interface ResolvedElement {
  nodeId: number;
  centerX: number;
  centerY: number;
  bounds: { x: number; y: number; width: number; height: number };
}

/**
 * Resolve a CSS selector to an element's position using CDP DOM methods.
 * DOM-first pipeline: avoids expensive full AX tree queries.
 *
 * Pipeline:
 * 1. DOM.getDocument({pierce: true}) to get root node
 * 2. DOM.querySelector to find element
 * 3. DOM.scrollIntoViewIfNeeded to ensure visibility
 * 4. DOM.getContentQuads to get element bounds
 * 5. Calculate center point
 */
export async function resolveSelector(
  cdp: CDPManager,
  tabId: number,
  selector: string,
): Promise<ResolvedElement> {
  // Get document root
  const doc = (await cdp.send(tabId, 'DOM.getDocument', {
    depth: 0,
    pierce: true,
  })) as any;
  const rootNodeId = doc.root.nodeId;

  // Query selector
  const result = (await cdp.send(tabId, 'DOM.querySelector', {
    nodeId: rootNodeId,
    selector,
  })) as any;

  if (!result.nodeId || result.nodeId === 0) {
    throw new SelectorNotFoundError(`Selector not found: ${selector}`);
  }

  const nodeId = result.nodeId;

  // Scroll into view
  await cdp.send(tabId, 'DOM.scrollIntoViewIfNeeded', { nodeId });

  // Get element bounds
  const quads = (await cdp.send(tabId, 'DOM.getContentQuads', {
    nodeId,
  })) as any;

  if (!quads.quads || quads.quads.length === 0) {
    throw new SelectorNotFoundError(
      `Element has no visual bounds: ${selector}`,
    );
  }

  return buildResolvedElement(nodeId, quads.quads[0]);
}

/**
 * Resolve an accessibility selector (role + name) using CDP Accessibility API.
 * Only used for getByRole, getByText, getByLabel -- more expensive than DOM query.
 */
export async function resolveA11ySelector(
  cdp: CDPManager,
  tabId: number,
  role?: string,
  name?: string,
): Promise<ResolvedElement> {
  // Get document root for the AX query
  const doc = (await cdp.send(tabId, 'DOM.getDocument', {
    depth: 0,
    pierce: true,
  })) as any;

  // Use Accessibility.queryAXTree for role/name matching
  const axResult = (await cdp.send(tabId, 'Accessibility.queryAXTree', {
    nodeId: doc.root.nodeId,
    role,
    name,
  })) as any;

  if (!axResult.nodes || axResult.nodes.length === 0) {
    const desc =
      role && name
        ? `role="${role}" name="${name}"`
        : role
          ? `role="${role}"`
          : `name="${name}"`;
    throw new SelectorNotFoundError(`A11y selector not found: ${desc}`);
  }

  // Get the backend node ID from the first matching AX node
  const axNode = axResult.nodes[0];
  const backendNodeId = axNode.backendDOMNodeId;

  // Resolve backendNodeId to a remote object, then request a DOM nodeId
  const resolved = (await cdp.send(tabId, 'DOM.resolveNode', {
    backendNodeId,
  })) as any;

  const requested = (await cdp.send(tabId, 'DOM.requestNode', {
    objectId: resolved.object.objectId,
  })) as any;

  const nodeId = requested.nodeId;

  // Scroll into view
  await cdp.send(tabId, 'DOM.scrollIntoViewIfNeeded', { nodeId });

  // Get element bounds
  const quads = (await cdp.send(tabId, 'DOM.getContentQuads', {
    nodeId,
  })) as any;

  if (!quads.quads || quads.quads.length === 0) {
    throw new SelectorNotFoundError('A11y element has no visual bounds');
  }

  return buildResolvedElement(nodeId, quads.quads[0]);
}

/**
 * Build a ResolvedElement from a nodeId and a content quad.
 * Content quads are arrays of 8 numbers (4 x,y pairs for the quad corners).
 */
function buildResolvedElement(
  nodeId: number,
  quad: number[],
): ResolvedElement {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const bounds = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };

  return {
    nodeId,
    centerX: bounds.x + bounds.width / 2,
    centerY: bounds.y + bounds.height / 2,
    bounds,
  };
}

export class SelectorNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelectorNotFoundError';
  }
}
