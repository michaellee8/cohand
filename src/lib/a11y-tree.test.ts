// @vitest-environment happy-dom

import { describe, it, expect, beforeEach } from 'vitest';
import { generateAccessibilityTree, getElementByRefId, clearRefMap } from './a11y-tree';
import type { A11yNode } from './a11y-tree';

beforeEach(() => {
  document.body.innerHTML = '';
  clearRefMap();
});

describe('generateAccessibilityTree', () => {
  it('generates tree from simple DOM (button, link, input)', () => {
    document.body.innerHTML = `
      <button>Click me</button>
      <a href="https://example.com">Visit</a>
      <input type="text" aria-label="Username" />
    `;

    const tree = generateAccessibilityTree();
    expect(tree).not.toBeNull();

    // Find the button, link, and input nodes in the tree
    const nodes = flattenTree(tree!);
    const button = nodes.find(n => n.role === 'button' && n.name === 'Click me');
    const link = nodes.find(n => n.role === 'link' && n.name === 'Visit');
    const textbox = nodes.find(n => n.role === 'textbox' && n.name === 'Username');

    expect(button).toBeDefined();
    expect(button!.interactive).toBe(true);

    expect(link).toBeDefined();
    expect(link!.interactive).toBe(true);
    expect(link!.attributes?.href).toBe('https://example.com');

    expect(textbox).toBeDefined();
    expect(textbox!.interactive).toBe(true);
  });

  it('extracts correct explicit roles', () => {
    document.body.innerHTML = `
      <div role="navigation">
        <span role="menuitem">Item 1</span>
      </div>
    `;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);

    expect(nodes.find(n => n.role === 'navigation')).toBeDefined();
    expect(nodes.find(n => n.role === 'menuitem' && n.name === 'Item 1')).toBeDefined();
  });

  it('extracts correct implicit roles', () => {
    document.body.innerHTML = `
      <nav><a href="/home">Home</a></nav>
      <main><h1>Title</h1></main>
      <footer>Footer</footer>
      <aside>Sidebar</aside>
      <form><select><option>A</option></select></form>
      <ul><li>Item</li></ul>
    `;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);

    expect(nodes.find(n => n.role === 'navigation')).toBeDefined();
    expect(nodes.find(n => n.role === 'link' && n.name === 'Home')).toBeDefined();
    expect(nodes.find(n => n.role === 'main')).toBeDefined();
    expect(nodes.find(n => n.role === 'heading' && n.name === 'Title')).toBeDefined();
    expect(nodes.find(n => n.role === 'contentinfo')).toBeDefined();
    expect(nodes.find(n => n.role === 'complementary')).toBeDefined();
    expect(nodes.find(n => n.role === 'form')).toBeDefined();
    expect(nodes.find(n => n.role === 'combobox')).toBeDefined();
    expect(nodes.find(n => n.role === 'list')).toBeDefined();
    expect(nodes.find(n => n.role === 'listitem' && n.name === 'Item')).toBeDefined();
  });

  it('extracts input type roles correctly', () => {
    document.body.innerHTML = `
      <input type="text" aria-label="text" />
      <input type="checkbox" aria-label="check" />
      <input type="radio" aria-label="radio" />
      <input type="range" aria-label="range" />
      <input type="number" aria-label="number" />
      <input type="search" aria-label="search" />
      <input type="submit" value="Submit" />
    `;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);

    expect(nodes.find(n => n.role === 'textbox' && n.name === 'text')).toBeDefined();
    expect(nodes.find(n => n.role === 'checkbox' && n.name === 'check')).toBeDefined();
    expect(nodes.find(n => n.role === 'radio' && n.name === 'radio')).toBeDefined();
    expect(nodes.find(n => n.role === 'slider' && n.name === 'range')).toBeDefined();
    expect(nodes.find(n => n.role === 'spinbutton' && n.name === 'number')).toBeDefined();
    expect(nodes.find(n => n.role === 'searchbox' && n.name === 'search')).toBeDefined();
    expect(nodes.find(n => n.role === 'button')).toBeDefined();
  });

  it('extracts accessible names from aria-label', () => {
    document.body.innerHTML = `<button aria-label="Close dialog">X</button>`;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);
    const button = nodes.find(n => n.role === 'button');
    expect(button?.name).toBe('Close dialog');
  });

  it('extracts accessible names from textContent for buttons/links', () => {
    document.body.innerHTML = `<button>Save Changes</button>`;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);
    const button = nodes.find(n => n.role === 'button');
    expect(button?.name).toBe('Save Changes');
  });

  it('extracts accessible names from label[for]', () => {
    document.body.innerHTML = `
      <label for="email-input">Email Address</label>
      <input id="email-input" type="email" />
    `;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);
    const input = nodes.find(n => n.role === 'textbox');
    expect(input?.name).toBe('Email Address');
  });

  it('extracts accessible names from aria-labelledby', () => {
    document.body.innerHTML = `
      <span id="label1">First</span>
      <span id="label2">Last</span>
      <input type="text" aria-labelledby="label1 label2" />
    `;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);
    const input = nodes.find(n => n.role === 'textbox');
    expect(input?.name).toBe('First Last');
  });

  it('extracts accessible names from alt text on images', () => {
    document.body.innerHTML = `<img alt="Company logo" src="logo.png" />`;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);
    const img = nodes.find(n => n.role === 'img');
    expect(img?.name).toBe('Company logo');
  });

  it('extracts accessible names from title attribute', () => {
    document.body.innerHTML = `<div title="More info">?</div>`;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);
    const div = nodes.find(n => n.name === 'More info');
    expect(div).toBeDefined();
  });

  it('marks interactive elements correctly', () => {
    document.body.innerHTML = `
      <button>Button</button>
      <a href="#">Link</a>
      <input type="text" aria-label="Input" />
      <select aria-label="Select"><option>A</option></select>
      <textarea aria-label="Textarea"></textarea>
      <div tabindex="0" title="Focusable div">Focusable div</div>
      <div role="button">ARIA button</div>
      <div onclick="handler()" title="Clickable">Clickable</div>
      <p>Not interactive</p>
    `;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);

    expect(nodes.find(n => n.role === 'button' && n.name === 'Button')?.interactive).toBe(true);
    expect(nodes.find(n => n.role === 'link')?.interactive).toBe(true);
    expect(nodes.find(n => n.role === 'textbox' && n.name === 'Input')?.interactive).toBe(true);
    expect(nodes.find(n => n.role === 'combobox')?.interactive).toBe(true);
    expect(nodes.find(n => n.role === 'textbox' && n.name === 'Textarea')?.interactive).toBe(true);

    // tabindex makes div interactive
    const focusable = nodes.find(n => n.name === 'Focusable div');
    expect(focusable?.interactive).toBe(true);

    // role="button" makes div interactive
    const ariaBtn = nodes.find(n => n.role === 'button' && n.name === 'ARIA button');
    expect(ariaBtn?.interactive).toBe(true);

    // onclick makes div interactive
    const clickable = nodes.find(n => n.name === 'Clickable');
    expect(clickable?.interactive).toBe(true);
  });

  it('skips hidden elements (hidden attribute)', () => {
    document.body.innerHTML = `
      <button>Visible</button>
      <button hidden>Hidden</button>
    `;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);
    expect(nodes.find(n => n.name === 'Visible')).toBeDefined();
    expect(nodes.find(n => n.name === 'Hidden')).toBeUndefined();
  });

  it('skips hidden elements (aria-hidden)', () => {
    document.body.innerHTML = `
      <button>Visible</button>
      <button aria-hidden="true">Aria Hidden</button>
    `;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);
    expect(nodes.find(n => n.name === 'Visible')).toBeDefined();
    expect(nodes.find(n => n.name === 'Aria Hidden')).toBeUndefined();
  });

  it('skips hidden elements (display:none)', () => {
    document.body.innerHTML = `
      <button>Visible</button>
      <button style="display:none">Display None</button>
    `;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);
    expect(nodes.find(n => n.name === 'Visible')).toBeDefined();
    expect(nodes.find(n => n.name === 'Display None')).toBeUndefined();
  });

  it('skips hidden elements (visibility:hidden)', () => {
    document.body.innerHTML = `
      <button>Visible</button>
      <button style="visibility:hidden">Visibility Hidden</button>
    `;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);
    expect(nodes.find(n => n.name === 'Visible')).toBeDefined();
    expect(nodes.find(n => n.name === 'Visibility Hidden')).toBeUndefined();
  });

  it('skips script, style, noscript, and template elements', () => {
    document.body.innerHTML = `
      <script>var x = 1;</script>
      <style>.a { color: red; }</style>
      <noscript>No JS</noscript>
      <template><div>Template content</div></template>
      <button>Real Button</button>
    `;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);
    expect(nodes.find(n => n.name === 'Real Button')).toBeDefined();
    // None of the skipped elements should appear
    expect(nodes.every(n => !['var x = 1;', '.a { color: red; }', 'No JS', 'Template content'].includes(n.name))).toBe(true);
  });

  it('collapses single-child generic containers', () => {
    document.body.innerHTML = `
      <div>
        <div>
          <div>
            <button>Deep Button</button>
          </div>
        </div>
      </div>
    `;

    const tree = generateAccessibilityTree();
    // The tree root should eventually contain the button without
    // intermediate generic wrappers (they get collapsed)
    const nodes = flattenTree(tree!);
    const button = nodes.find(n => n.role === 'button' && n.name === 'Deep Button');
    expect(button).toBeDefined();

    // Count the generic nodes — nested single-child generics should be collapsed
    const genericNodes = nodes.filter(n => n.role === 'generic');
    // Because each wrapper has only one child and is generic with no name,
    // they should all be collapsed away
    expect(genericNodes.length).toBe(0);
  });

  it('does not collapse generic containers with multiple children', () => {
    document.body.innerHTML = `
      <div>
        <button>Button A</button>
        <button>Button B</button>
      </div>
    `;

    const tree = generateAccessibilityTree();
    expect(tree).not.toBeNull();
    // The root should be a generic node with two children
    expect(tree!.children?.length).toBe(2);
  });

  it('handles elements with no accessible name gracefully', () => {
    // All generic, no interactive, no name, no children with content
    // => tree collapses to null (entire subtree pruned)
    document.body.innerHTML = `
      <div>
        <div>
          <span>Some text</span>
        </div>
      </div>
    `;

    const tree1 = generateAccessibilityTree();
    // All nodes are generic with no name, no interactivity, so they get pruned
    expect(tree1).toBeNull();

    // With at least one semantic/interactive element, tree is produced
    document.body.innerHTML = `
      <div>
        <div>
          <button>OK</button>
        </div>
        <img alt="" src="spacer.gif" />
      </div>
    `;

    const tree2 = generateAccessibilityTree();
    expect(tree2).not.toBeNull();
    const nodes = flattenTree(tree2!);
    // All name fields should be strings (never undefined/null)
    for (const node of nodes) {
      expect(typeof node.name).toBe('string');
    }
  });

  it('assigns refIds to interactive and non-generic elements', () => {
    document.body.innerHTML = `
      <nav>
        <a href="/home">Home</a>
      </nav>
      <div>
        <button>Click</button>
      </div>
    `;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);

    const nav = nodes.find(n => n.role === 'navigation');
    expect(nav?.refId).toMatch(/^ref-\d+$/);

    const link = nodes.find(n => n.role === 'link');
    expect(link?.refId).toMatch(/^ref-\d+$/);

    const button = nodes.find(n => n.role === 'button');
    expect(button?.refId).toMatch(/^ref-\d+$/);
  });

  it('does not assign refIds to generic non-interactive nodes', () => {
    document.body.innerHTML = `
      <div>
        <button>A</button>
        <button>B</button>
      </div>
    `;

    const tree = generateAccessibilityTree();
    // Root is generic, non-interactive, with multiple children
    expect(tree?.role).toBe('generic');
    expect(tree?.refId).toBe('');
  });

  it('extracts attributes (href, checked, disabled, aria-expanded)', () => {
    document.body.innerHTML = `
      <a href="https://example.com">Link</a>
      <input type="checkbox" aria-label="Agree" checked />
      <input type="text" aria-label="Disabled" disabled />
      <button aria-expanded="true">Menu</button>
    `;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);

    const link = nodes.find(n => n.role === 'link');
    expect(link?.attributes?.href).toBe('https://example.com');

    const checkbox = nodes.find(n => n.role === 'checkbox');
    expect(checkbox?.attributes?.checked).toBe('true');

    const disabledInput = nodes.find(n => n.name === 'Disabled');
    expect(disabledInput?.attributes?.disabled).toBe('true');

    const expandedBtn = nodes.find(n => n.name === 'Menu');
    expect(expandedBtn?.attributes?.['aria-expanded']).toBe('true');
  });

  it('extracts section with aria-label as region', () => {
    document.body.innerHTML = `
      <section aria-label="Main content">
        <p>Hello</p>
      </section>
    `;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);
    const region = nodes.find(n => n.role === 'region' && n.name === 'Main content');
    expect(region).toBeDefined();
  });

  it('treats section without aria-label as generic', () => {
    document.body.innerHTML = `
      <section>
        <button>A</button>
        <button>B</button>
      </section>
    `;

    const tree = generateAccessibilityTree();
    // The section has no aria-label, so role is generic
    // It has two children so it won't be collapsed
    expect(tree?.role).toBe('generic');
  });

  it('redacts password input values', () => {
    document.body.innerHTML = `
      <input type="password" aria-label="Password" value="secret123" />
    `;
    // happy-dom may not reflect the value attribute into .value automatically,
    // so set it programmatically
    const input = document.querySelector('input') as HTMLInputElement;
    input.value = 'secret123';

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);
    const pw = nodes.find(n => n.name === 'Password');
    expect(pw).toBeDefined();
    expect(pw!.attributes?.value).toBe('[REDACTED]');
  });

  it('redacts values for sensitive autocomplete inputs', () => {
    document.body.innerHTML = `
      <input type="text" autocomplete="cc-number" aria-label="Card" />
      <input type="text" autocomplete="one-time-code" aria-label="OTP" />
    `;
    const inputs = document.querySelectorAll('input');
    (inputs[0] as HTMLInputElement).value = '4111111111111111';
    (inputs[1] as HTMLInputElement).value = '123456';

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);

    const card = nodes.find(n => n.name === 'Card');
    expect(card).toBeDefined();
    expect(card!.attributes?.value).toBe('[REDACTED]');

    const otp = nodes.find(n => n.name === 'OTP');
    expect(otp).toBeDefined();
    expect(otp!.attributes?.value).toBe('[REDACTED]');
  });

  it('redacts values for inputs with sensitive name/id patterns', () => {
    document.body.innerHTML = `
      <input type="text" name="user_password" aria-label="PW" />
      <input type="text" id="ssn-field" aria-label="SSN" />
    `;
    const inputs = document.querySelectorAll('input');
    (inputs[0] as HTMLInputElement).value = 'hunter2';
    (inputs[1] as HTMLInputElement).value = '123-45-6789';

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);

    expect(nodes.find(n => n.name === 'PW')!.attributes?.value).toBe('[REDACTED]');
    expect(nodes.find(n => n.name === 'SSN')!.attributes?.value).toBe('[REDACTED]');
  });

  it('does NOT redact values for non-sensitive text inputs', () => {
    document.body.innerHTML = `
      <input type="text" aria-label="Username" />
    `;
    const input = document.querySelector('input') as HTMLInputElement;
    input.value = 'alice';

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);
    const username = nodes.find(n => n.name === 'Username');
    expect(username).toBeDefined();
    expect(username!.attributes?.value).toBe('alice');
  });

  it('uses CSS.escape for label-for selectors', () => {
    // An ID with CSS metacharacters should still match via CSS.escape
    document.body.innerHTML = `
      <label for="field:name">Field Name</label>
      <input id="field:name" type="text" />
    `;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);
    const input = nodes.find(n => n.role === 'textbox');
    expect(input).toBeDefined();
    expect(input!.name).toBe('Field Name');
  });
});

describe('getElementByRefId', () => {
  it('returns the correct element by refId', () => {
    document.body.innerHTML = `<button>Test Button</button>`;

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);
    const button = nodes.find(n => n.role === 'button');
    expect(button).toBeDefined();

    const element = getElementByRefId(button!.refId);
    expect(element).not.toBeNull();
    expect(element?.tagName.toLowerCase()).toBe('button');
    expect(element?.textContent).toBe('Test Button');
  });

  it('returns null for unknown refId', () => {
    const element = getElementByRefId('ref-nonexistent');
    expect(element).toBeNull();
  });

  it('returns null after clearRefMap', () => {
    document.body.innerHTML = `<button>Test</button>`;
    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);
    const button = nodes.find(n => n.role === 'button');
    expect(button).toBeDefined();

    clearRefMap();
    const element = getElementByRefId(button!.refId);
    expect(element).toBeNull();
  });

  it('reuses refId for same element across multiple tree generations', () => {
    document.body.innerHTML = `<button>Stable</button>`;

    const tree1 = generateAccessibilityTree();
    const nodes1 = flattenTree(tree1!);
    const refId1 = nodes1.find(n => n.role === 'button')!.refId;

    const tree2 = generateAccessibilityTree();
    const nodes2 = flattenTree(tree2!);
    const refId2 = nodes2.find(n => n.role === 'button')!.refId;

    expect(refId1).toBe(refId2);
  });
});

describe('shadow DOM traversal', () => {
  it('traverses shadow DOM children', () => {
    // Create a custom element with shadow DOM
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const btn = document.createElement('button');
    btn.textContent = 'Shadow Button';
    shadow.appendChild(btn);
    document.body.appendChild(host);

    const tree = generateAccessibilityTree();
    const nodes = flattenTree(tree!);
    const shadowBtn = nodes.find(n => n.role === 'button' && n.name === 'Shadow Button');
    expect(shadowBtn).toBeDefined();
    expect(shadowBtn!.interactive).toBe(true);
  });
});

// Helper to flatten a tree into a list of all nodes
function flattenTree(node: A11yNode): A11yNode[] {
  const result: A11yNode[] = [node];
  if (node.children) {
    for (const child of node.children) {
      result.push(...flattenTree(child));
    }
  }
  return result;
}
