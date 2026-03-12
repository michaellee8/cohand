/**
 * Content-script recording overlay.
 *
 * activate()  -- start capturing user interactions
 * deactivate() -- tear down all listeners and DOM artifacts
 *
 * Sends RECORDING_ACTION messages to the
 * service worker via chrome.runtime.sendMessage.
 */

import { CLICK_DEDUP_MS } from '../../constants';
import type { RawRecordingAction } from '../../types/recording';

// ---------------------------------------------------------------------------
// A11y subtree builder (lightweight, depth-limited)
// ---------------------------------------------------------------------------

interface MiniA11yNode {
  role: string;
  name?: string;
  children?: MiniA11yNode[];
  [key: string]: unknown;
}

const MAX_A11Y_SUBTREE_DEPTH = 3;

function getImplicitRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;

  const tag = el.tagName.toLowerCase();
  const map: Record<string, string> = {
    a: el.hasAttribute('href') ? 'link' : 'generic',
    button: 'button',
    input: 'textbox',
    select: 'combobox',
    textarea: 'textbox',
    img: 'img',
    nav: 'navigation',
    main: 'main',
    h1: 'heading', h2: 'heading', h3: 'heading',
    h4: 'heading', h5: 'heading', h6: 'heading',
  };
  return map[tag] || 'generic';
}

function getAccessibleName(el: Element): string | undefined {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.slice(0, 500);

  const ariaLabelledBy = el.getAttribute('aria-labelledby');
  if (ariaLabelledBy) {
    const parts = ariaLabelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() || '')
      .filter(Boolean);
    if (parts.length) return parts.join(' ');
  }

  if (el instanceof HTMLImageElement && el.alt) return el.alt;

  const role = getImplicitRole(el);
  if (['button', 'link', 'heading'].includes(role)) {
    const text = el.textContent?.trim().slice(0, 200);
    if (text) return text;
  }

  const title = el.getAttribute('title');
  if (title) return title;

  return undefined;
}

function buildA11ySubtree(root: Element, depth = 0): MiniA11yNode {
  const node: MiniA11yNode = { role: getImplicitRole(root) };
  const name = getAccessibleName(root);
  if (name) node.name = name;

  if (depth < MAX_A11Y_SUBTREE_DEPTH) {
    const kids: MiniA11yNode[] = [];
    for (const child of Array.from(root.children)) {
      kids.push(buildA11ySubtree(child, depth + 1));
    }
    if (kids.length) node.children = kids;
  }

  return node;
}

// ---------------------------------------------------------------------------
// CSS selector builder
// ---------------------------------------------------------------------------

function buildCssSelector(el: Element): string {
  // Priority: #id
  if (el.id) return `#${CSS.escape(el.id)}`;

  // aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`;

  // tag.class1.class2
  const tag = el.tagName.toLowerCase();
  if (el.classList.length > 0) {
    const classes = Array.from(el.classList).map((c) => `.${CSS.escape(c)}`).join('');
    return `${tag}${classes}`;
  }

  // plain tag
  return tag;
}

// ---------------------------------------------------------------------------
// Sensitive-input detection
// ---------------------------------------------------------------------------

const SENSITIVE_AUTOCOMPLETE = new Set([
  'cc-number', 'cc-csc', 'cc-exp',
  'new-password', 'current-password', 'one-time-code',
]);

const SENSITIVE_NAME_PATTERN =
  /password|passwd|pin|cvv|cvc|ssn|otp|mfa|totp|secret|token/i;

function isSensitiveInput(el: Element): boolean {
  if (el instanceof HTMLInputElement && el.type === 'password') return true;

  const autocomplete = el.getAttribute('autocomplete') || '';
  for (const token of autocomplete.split(/\s+/)) {
    if (SENSITIVE_AUTOCOMPLETE.has(token)) return true;
  }

  const name = el.getAttribute('name') || '';
  const id = el.getAttribute('id') || '';
  if (SENSITIVE_NAME_PATTERN.test(name) || SENSITIVE_NAME_PATTERN.test(id)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let active = false;
let highlightEl: HTMLDivElement | null = null;

// Click dedup state
let lastClickTarget: EventTarget | null = null;
let lastClickTime = 0;

// Keystroke buffer state
let keystrokeTarget: Element | null = null;
let keystrokeBuffer = '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendAction(action: RawRecordingAction): void {
  chrome.runtime.sendMessage({ type: 'RECORDING_ACTION', action });
}

// Allowlist of element attributes safe to capture during recording.
// All other attributes are filtered out to prevent leaking sensitive data
// (e.g. data-user-id, data-token, internal framework attributes).
const ALLOWED_ATTRIBUTES = new Set([
  'id', 'class', 'role', 'aria-label', 'data-testid',
  'href', 'type', 'name', 'placeholder', 'value',
]);

function collectElementMeta(el: Element): Partial<RawRecordingAction> {
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (ALLOWED_ATTRIBUTES.has(attr.name)) {
      attrs[attr.name] = attr.value;
    }
  }

  // Strip value attribute for sensitive inputs (passwords, credit cards, etc.)
  if (isSensitiveInput(el)) {
    delete attrs['value'];
  }

  return {
    selector: buildCssSelector(el),
    elementTag: el.tagName.toLowerCase(),
    elementText: el.textContent?.trim().slice(0, 500) || undefined,
    elementAttributes: Object.keys(attrs).length ? attrs : undefined,
    elementRole: getImplicitRole(el),
    a11ySubtree: buildA11ySubtree(el),
  };
}

// ---------------------------------------------------------------------------
// Event handlers (all use capture phase)
// ---------------------------------------------------------------------------

function onMouseOver(e: MouseEvent): void {
  if (!highlightEl || !(e.target instanceof Element)) return;
  const rect = (e.target as Element).getBoundingClientRect();
  highlightEl.style.display = 'block';
  highlightEl.style.top = `${rect.top}px`;
  highlightEl.style.left = `${rect.left}px`;
  highlightEl.style.width = `${rect.width}px`;
  highlightEl.style.height = `${rect.height}px`;
}

function onMouseOut(_e: MouseEvent): void {
  if (highlightEl) highlightEl.style.display = 'none';
}

function onClick(e: MouseEvent): void {
  const target = e.target;
  if (!(target instanceof Element)) return;

  // Dedup: same element within CLICK_DEDUP_MS
  const now = Date.now();
  if (target === lastClickTarget && now - lastClickTime < CLICK_DEDUP_MS) {
    return;
  }
  lastClickTarget = target;
  lastClickTime = now;

  // Flush any pending keystroke buffer (user clicked away from a field)
  flushKeystrokeBuffer();

  const meta = collectElementMeta(target);

  const action: RawRecordingAction = {
    action: 'click',
    timestamp: now,
    ...meta,
    viewportDimensions: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    clickPositionHint: { x: e.clientX, y: e.clientY },
    url: location.href,
    pageTitle: document.title,
  };

  sendAction(action);
}

function onKeyDown(e: KeyboardEvent): void {
  const target = e.target;
  if (!(target instanceof Element)) return;

  // Only capture keystrokes in editable elements
  const isEditable =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target as HTMLElement).isContentEditable;
  if (!isEditable) return;

  // If we switched to a different field, flush the old buffer first
  if (keystrokeTarget && keystrokeTarget !== target) {
    flushKeystrokeBuffer();
  }

  keystrokeTarget = target;

  // Accumulate printable characters
  if (e.key.length === 1) {
    keystrokeBuffer += e.key;
  } else if (e.key === 'Backspace' && keystrokeBuffer.length > 0) {
    keystrokeBuffer = keystrokeBuffer.slice(0, -1);
  } else if (e.key === 'Enter') {
    keystrokeBuffer += '\n';
  }

}

function onInput(e: Event): void {
  const target = e.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (!active) return;

  // Update keystroke buffer with the actual input value
  if (keystrokeTarget === target) {
    const sensitive = isSensitiveInput(target);
    keystrokeBuffer = sensitive ? '' : target.value;
  }
}

function onFocusOut(e: FocusEvent): void {
  if (!(e.target instanceof Element)) return;
  if (e.target === keystrokeTarget) {
    flushKeystrokeBuffer();
  }
}

function flushKeystrokeBuffer(): void {
  if (!keystrokeTarget || keystrokeBuffer.length === 0) {
    keystrokeTarget = null;
    keystrokeBuffer = '';
    return;
  }

  const el = keystrokeTarget;
  const sensitive = isSensitiveInput(el);
  const meta = collectElementMeta(el);

  const action: RawRecordingAction = {
    action: 'type',
    timestamp: Date.now(),
    ...meta,
    typedText: sensitive ? undefined : keystrokeBuffer,
    url: location.href,
    pageTitle: document.title,
    viewportDimensions: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
  };

  sendAction(action);

  keystrokeTarget = null;
  keystrokeBuffer = '';
}

// ---------------------------------------------------------------------------
// Highlight overlay element
// ---------------------------------------------------------------------------

function createHighlightElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.id = 'cohand-recording-highlight';
  el.style.cssText = [
    'position: fixed',
    'pointer-events: none',
    'border: 2px solid #3b82f6',
    'border-radius: 3px',
    'z-index: 2147483647',
    'display: none',
    'transition: top 0.05s, left 0.05s, width 0.05s, height 0.05s',
  ].join('; ');
  document.documentElement.appendChild(el);
  return el;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function activate(): void {
  if (active) return;
  active = true;

  highlightEl = createHighlightElement();

  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('mouseout', onMouseOut, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('focusout', onFocusOut, true);
}

export function deactivate(): void {
  if (!active) return;
  active = false;

  // Flush any pending keystrokes
  flushKeystrokeBuffer();
  keystrokeTarget = null;
  keystrokeBuffer = '';

  document.removeEventListener('mouseover', onMouseOver, true);
  document.removeEventListener('mouseout', onMouseOut, true);
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onKeyDown, true);
  document.removeEventListener('input', onInput, true);
  document.removeEventListener('focusout', onFocusOut, true);

  if (highlightEl) {
    highlightEl.remove();
    highlightEl = null;
  }

  lastClickTarget = null;
  lastClickTime = 0;
}
