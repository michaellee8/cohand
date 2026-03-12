import { describe, it, expect } from 'vitest';
import { validateAST } from './ast-validator';

describe('validateAST', () => {
  describe('valid scripts', () => {
    it('accepts a basic script with page methods', () => {
      const result = validateAST(`
        async function run(page, context) {
          await page.goto('https://example.com');
          await page.click('[aria-label="Like"]');
          const text = await page.locator('.price').textContent();
          context.state.price = text;
          return { price: text };
        }
      `);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts standard control flow', () => {
      const result = validateAST(`
        async function run(page, context) {
          for (let i = 0; i < 10; i++) {
            if (i % 2 === 0) {
              await page.scroll(100);
            }
          }
        }
      `);
      expect(result.valid).toBe(true);
    });

    it('accepts string concatenation and template literals', () => {
      const result = validateAST(`
        async function run(page, context) {
          const url = \`https://example.com/\${context.state.page}\`;
          await page.goto(url);
        }
      `);
      expect(result.valid).toBe(true);
    });
  });

  describe('blocked patterns', () => {
    it('blocks eval()', () => {
      const result = validateAST(`eval('alert(1)')`);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('eval'))).toBe(true);
    });

    it('blocks Function()', () => {
      const result = validateAST(`Function('return 1')()`);
      expect(result.valid).toBe(false);
    });

    it('blocks new Function()', () => {
      const result = validateAST(`new Function('return 1')()`);
      expect(result.valid).toBe(false);
    });

    it('blocks Function assigned to variable (identifier bypass)', () => {
      const result = validateAST(`const f = Function; f("evil")()`);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Function'))).toBe(true);
    });

    it('blocks eval assigned to variable', () => {
      const result = validateAST(`const e = eval; e("alert(1)")`);
      expect(result.valid).toBe(false);
    });

    it('blocks Reflect reference without call', () => {
      const result = validateAST(`const r = Reflect; r.apply(fn, null, [])`);
      expect(result.valid).toBe(false);
    });

    it('blocks fetch()', () => {
      const result = validateAST(`fetch('https://evil.com')`);
      expect(result.valid).toBe(false);
    });

    it('blocks new Proxy()', () => {
      const result = validateAST(`new Proxy({}, {})`);
      expect(result.valid).toBe(false);
    });

    it('blocks import()', () => {
      const result = validateAST(`import('module')`);
      expect(result.valid).toBe(false);
    });

    it('blocks computed access on globalThis', () => {
      const result = validateAST(`globalThis['ev' + 'al']('x')`);
      expect(result.valid).toBe(false);
    });

    it('blocks computed access on window', () => {
      const result = validateAST(`window['fetch']('x')`);
      expect(result.valid).toBe(false);
    });

    it('blocks .__proto__ access', () => {
      const result = validateAST(`const x = obj.__proto__`);
      expect(result.valid).toBe(false);
    });

    it('blocks .constructor access', () => {
      const result = validateAST(`const f = [].filter.constructor`);
      expect(result.valid).toBe(false);
    });

    it('blocks .evaluate access', () => {
      const result = validateAST(`page.evaluate(() => document.cookie)`);
      expect(result.valid).toBe(false);
    });

    it('blocks .mouse access', () => {
      const result = validateAST(`page.mouse.click(100, 200)`);
      expect(result.valid).toBe(false);
    });

    it('blocks .keyboard access', () => {
      const result = validateAST(`page.keyboard.type('text')`);
      expect(result.valid).toBe(false);
    });

    it('blocks WebSocket', () => {
      const result = validateAST(`new WebSocket('ws://evil.com')`);
      expect(result.valid).toBe(false);
    });

    it('blocks XMLHttpRequest', () => {
      const result = validateAST(`XMLHttpRequest()`);
      expect(result.valid).toBe(false);
    });

    it('blocks with statement', () => {
      // Note: 'with' is not valid in strict mode but our parser uses script mode
      const result = validateAST(`with (obj) { x = 1; }`);
      expect(result.valid).toBe(false);
    });

    it('blocks computed string access to blocked members', () => {
      const result = validateAST(`obj["constructor"]`);
      expect(result.valid).toBe(false);
    });

    it('returns parse error for invalid syntax', () => {
      const result = validateAST(`function {{{ invalid`);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Parse error');
    });

    it('blocks tagged template on non-literal', () => {
      const result = validateAST("const x = fn`template`");
      expect(result.valid).toBe(false);
    });

    it('blocks non-literal computed access on any object', () => {
      const result = validateAST(`const key = 'constructor'; page[key]()`);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('non-literal computed'))).toBe(true);
    });

    it('blocks string concatenation to build blocked member names', () => {
      const result = validateAST(`page['constr' + 'uctor']('return 1')()`);
      expect(result.valid).toBe(false);
    });

    it('blocks prototype chain access via variable', () => {
      const result = validateAST(`const c = 'constructor'; [].fill[c]('return fetch')()`);
      expect(result.valid).toBe(false);
    });

    it('blocks template literal computed access', () => {
      const result = validateAST("page[`constructor`]()");
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('constructor'))).toBe(true);
    });

    it('allows safe computed access with number literals', () => {
      const result = validateAST(`const arr = [1,2,3]; arr[0]`);
      expect(result.valid).toBe(true);
    });

    it('allows safe computed access with string literals not in blocklist', () => {
      const result = validateAST(`const obj = {}; obj['name']`);
      expect(result.valid).toBe(true);
    });
  });
});
