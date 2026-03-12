export interface A11yNode {
  role: string;
  name: string;
  refId: string; // unique id assigned to the element
  children?: A11yNode[];
  attributes?: Record<string, string>; // href, value, checked, etc.
  interactive?: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
}

// Map from refId to element (WeakRef for GC)
const refMap = new Map<string, WeakRef<Element>>();
let nextRefId = 0;

function getRefId(element: Element): string {
  // Check if element already has a ref
  const existing = element.getAttribute('data-cohand-ref');
  if (existing && refMap.has(existing)) return existing;

  const id = `ref-${nextRefId++}`;
  element.setAttribute('data-cohand-ref', id);
  refMap.set(id, new WeakRef(element));
  return id;
}

// Get the ARIA role for an element (explicit or implicit)
function getRole(element: Element): string {
  const explicit = element.getAttribute('role');
  if (explicit) return explicit;

  // Implicit roles based on tag
  const tag = element.tagName.toLowerCase();
  const implicitRoles: Record<string, string> = {
    a: element.hasAttribute('href') ? 'link' : 'generic',
    button: 'button',
    input: getInputRole(element as HTMLInputElement),
    select: 'combobox',
    textarea: 'textbox',
    img: 'img',
    h1: 'heading', h2: 'heading', h3: 'heading',
    h4: 'heading', h5: 'heading', h6: 'heading',
    nav: 'navigation',
    main: 'main',
    header: 'banner',
    footer: 'contentinfo',
    aside: 'complementary',
    form: 'form',
    table: 'table',
    ul: 'list', ol: 'list',
    li: 'listitem',
    dialog: 'dialog',
    section: element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby') ? 'region' : 'generic',
  };
  return implicitRoles[tag] || 'generic';
}

function getInputRole(input: HTMLInputElement): string {
  const type = input.type?.toLowerCase() || 'text';
  const typeRoles: Record<string, string> = {
    text: 'textbox', search: 'searchbox', email: 'textbox',
    tel: 'textbox', url: 'textbox', password: 'textbox',
    number: 'spinbutton', range: 'slider',
    checkbox: 'checkbox', radio: 'radio',
    button: 'button', submit: 'button', reset: 'button',
    image: 'button',
  };
  return typeRoles[type] || 'textbox';
}

// Get accessible name
function getAccessibleName(element: Element): string {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;

  const ariaLabelledBy = element.getAttribute('aria-labelledby');
  if (ariaLabelledBy) {
    const labels = ariaLabelledBy.split(/\s+/).map(id => {
      const el = document.getElementById(id);
      return el?.textContent?.trim() || '';
    });
    const combined = labels.filter(Boolean).join(' ');
    if (combined) return combined;
  }

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    if (element.id) {
      const labelEl = document.querySelector(`label[for="${element.id}"]`);
      if (labelEl) return labelEl.textContent?.trim() || '';
    }
  }

  if (element instanceof HTMLImageElement) {
    return element.alt || '';
  }

  // For buttons and links, use textContent
  const role = getRole(element);
  if (['button', 'link', 'heading', 'listitem', 'menuitem'].includes(role)) {
    return element.textContent?.trim().slice(0, 200) || '';
  }

  const title = element.getAttribute('title');
  if (title) return title;

  return '';
}

function isInteractive(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (['a', 'button', 'input', 'select', 'textarea'].includes(tag)) return true;
  if (element.getAttribute('tabindex') !== null) return true;
  if (element.getAttribute('role') && ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'textbox', 'combobox', 'searchbox', 'slider', 'spinbutton'].includes(element.getAttribute('role')!)) return true;
  if (element.getAttribute('onclick') || element.getAttribute('onkeydown')) return true;
  return false;
}

function getAttributes(element: Element): Record<string, string> | undefined {
  const attrs: Record<string, string> = {};
  const href = element.getAttribute('href');
  if (href) attrs.href = href;

  if (element instanceof HTMLInputElement) {
    if (element.value) attrs.value = element.value;
    if (element.type === 'checkbox' || element.type === 'radio') {
      attrs.checked = String(element.checked);
    }
    if (element.placeholder) attrs.placeholder = element.placeholder;
    if (element.disabled) attrs.disabled = 'true';
  }

  const ariaExpanded = element.getAttribute('aria-expanded');
  if (ariaExpanded) attrs['aria-expanded'] = ariaExpanded;

  const ariaSelected = element.getAttribute('aria-selected');
  if (ariaSelected) attrs['aria-selected'] = ariaSelected;

  const ariaDisabled = element.getAttribute('aria-disabled');
  if (ariaDisabled) attrs['aria-disabled'] = ariaDisabled;

  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

// Walk the DOM tree and build a11y tree
function walkElement(element: Element, depth: number = 0): A11yNode | null {
  // Skip hidden elements
  if (element instanceof HTMLElement) {
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return null;
    // Fast-path: offsetParent is null for display:none (skip expensive getComputedStyle)
    // Does not apply to body/html or fixed/sticky elements
    if (element.offsetParent === null && element !== document.body && element !== document.documentElement) {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return null;
      // If position is not fixed/sticky and has no offsetParent, skip (likely not visible)
      if (style.position !== 'fixed' && style.position !== 'sticky' && style.display !== 'contents') return null;
    } else {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return null;
    }
  }

  // Skip script, style, noscript
  const tag = element.tagName.toLowerCase();
  if (['script', 'style', 'noscript', 'template'].includes(tag)) return null;

  const role = getRole(element);
  const name = getAccessibleName(element);
  const interactive = isInteractive(element);
  const attributes = getAttributes(element);

  // Collect children (including shadow DOM)
  const children: A11yNode[] = [];
  const childElements = element.shadowRoot
    ? Array.from(element.shadowRoot.children)
    : Array.from(element.children);

  for (const child of childElements) {
    const childNode = walkElement(child, depth + 1);
    if (childNode) children.push(childNode);
  }

  // Skip generic non-interactive nodes with no name that just have one child
  if (role === 'generic' && !interactive && !name && children.length === 1 && !attributes) {
    return children[0];
  }

  // Skip generic non-interactive nodes with no name and no children
  if (role === 'generic' && !interactive && !name && children.length === 0 && !attributes) {
    return null;
  }

  const node: A11yNode = {
    role,
    name,
    refId: interactive || role !== 'generic' ? getRefId(element) : '',
  };

  if (children.length > 0) node.children = children;
  if (attributes) node.attributes = attributes;
  if (interactive) node.interactive = true;

  return node;
}

export function generateAccessibilityTree(): A11yNode | null {
  // Clear stale refs from previous tree generation
  refMap.clear();
  nextRefId = 0;
  return walkElement(document.body);
}

export function getElementByRefId(refId: string): Element | null {
  const ref = refMap.get(refId);
  if (!ref) return null;
  const el = ref.deref();
  if (!el) {
    refMap.delete(refId);
    return null;
  }
  return el;
}

export function clearRefMap(): void {
  refMap.clear();
  nextRefId = 0;
}
