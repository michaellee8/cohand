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
    // Block ALL references to dangerous globals (not just call sites)
    Identifier(node) {
      if (BLOCKED_GLOBALS.has(node.name)) {
        errors.push(`Blocked reference to '${node.name}' at line ${node.loc?.start?.line}`);
      }
    },

    // Block import() expressions
    ImportExpression(node) {
      errors.push(`Blocked dynamic import() at line ${node.loc?.start?.line}`);
    },

    // Check member access
    MemberExpression(node) {
      if (node.computed) {
        // Block ALL computed access on global-like objects
        if (node.object.type === 'Identifier' &&
            ['globalThis', 'window', 'self', 'this'].includes(node.object.name)) {
          errors.push(`Blocked computed member access on '${node.object.name}'`);
          return;
        }

        // Block ALL non-literal computed access (variable keys can construct any member name)
        if (node.property.type !== 'Literal' && node.property.type !== 'TemplateLiteral') {
          errors.push(`Blocked non-literal computed member access at line ${node.loc?.start?.line}`);
          return;
        }

        // Block template literals in computed access (could contain blocked members)
        if (node.property.type === 'TemplateLiteral') {
          // Check if any quasis contain blocked substrings
          const quasis = (node.property as any).quasis || [];
          for (const quasi of quasis) {
            const value = quasi.value?.raw || quasi.value?.cooked || '';
            if (BLOCKED_MEMBERS.has(value)) {
              errors.push(`Blocked computed access to template containing '${value}'`);
            }
          }
          // If template has expressions, it's dynamic — block it
          const expressions = (node.property as any).expressions || [];
          if (expressions.length > 0) {
            errors.push(`Blocked dynamic template literal computed access at line ${node.loc?.start?.line}`);
          }
          return;
        }

        // Block string literal access to blocked members
        if (typeof node.property.value === 'string') {
          if (BLOCKED_MEMBERS.has(node.property.value)) {
            errors.push(`Blocked computed access to '["${node.property.value}"]'`);
          }
        }
      }

      // Block dangerous property access (non-computed, identifier)
      if (!node.computed && node.property.type === 'Identifier') {
        if (BLOCKED_MEMBERS.has(node.property.name)) {
          errors.push(`Blocked access to '.${node.property.name}'`);
        }
      }
    },

    // Block string concatenation that might build blocked member names
    BinaryExpression(node) {
      if (node.operator === '+') {
        const hasBlockedSubstring = (n: any): boolean => {
          if (n.type === 'Literal' && typeof n.value === 'string') {
            const lower = n.value.toLowerCase();
            return ['constructor', '__proto__', 'prototype', 'eval', 'function'].some(
              blocked => lower.includes(blocked) || blocked.includes(lower)
            );
          }
          return false;
        };
        if (hasBlockedSubstring(node.left) || hasBlockedSubstring(node.right)) {
          errors.push(`Blocked string concatenation containing blocked substring at line ${node.loc?.start?.line}`);
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
