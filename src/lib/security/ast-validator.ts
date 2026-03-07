import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

export interface ASTValidationResult {
  valid: boolean;
  errors: string[];
}

// Blocked global identifiers
const BLOCKED_GLOBALS = new Set([
  'eval', 'Function', 'Proxy', 'Reflect',
  'fetch', 'XMLHttpRequest', 'WebSocket',
  'importScripts', 'require',
]);

// Blocked member access
const BLOCKED_MEMBERS = new Set([
  'constructor', '__proto__', 'prototype',
  'evaluate', '$', '$$', 'content',
  'mouse', 'keyboard', 'route',
  'exposeFunction', 'addInitScript',
]);

export function validateAST(source: string): ASTValidationResult {
  const errors: string[] = [];

  // Parse
  let ast: acorn.Program;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: 2022,
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      locations: true,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, errors: [`Parse error: ${message}`] };
  }

  walk.simple(ast, {
    // Block direct calls to dangerous globals
    CallExpression(node) {
      if (node.callee.type === 'Identifier') {
        if (BLOCKED_GLOBALS.has(node.callee.name)) {
          errors.push(`Blocked call to '${node.callee.name}' at line ${node.loc?.start?.line}`);
        }
      }
    },

    // Block import() expressions
    ImportExpression(node) {
      errors.push(`Blocked dynamic import() at line ${node.loc?.start?.line}`);
    },

    // Check member access
    MemberExpression(node) {
      // Block computed access on global-like objects
      if (node.computed) {
        if (node.object.type === 'Identifier' &&
            ['globalThis', 'window', 'self', 'this'].includes(node.object.name)) {
          errors.push(`Blocked computed member access on '${node.object.name}'`);
        }
      }

      // Block dangerous property access (non-computed, identifier)
      if (!node.computed && node.property.type === 'Identifier') {
        if (BLOCKED_MEMBERS.has(node.property.name)) {
          errors.push(`Blocked access to '.${node.property.name}'`);
        }
      }

      // Block string literal property access to blocked members (computed)
      if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') {
        if (BLOCKED_MEMBERS.has(node.property.value)) {
          errors.push(`Blocked computed access to '["${node.property.value}"]'`);
        }
      }
    },

    // Block new on dangerous globals (Function, Proxy, WebSocket, etc.)
    NewExpression(node) {
      if (node.callee.type === 'Identifier') {
        if (BLOCKED_GLOBALS.has(node.callee.name)) {
          errors.push(`Blocked new ${node.callee.name}()`);
        }
      }
    },

    // Block with statements
    WithStatement(_node) {
      errors.push(`Blocked 'with' statement`);
    },

    // Block tagged template expressions
    TaggedTemplateExpression(_node) {
      errors.push(`Blocked tagged template expression`);
    },
  });

  return { valid: errors.length === 0, errors };
}
