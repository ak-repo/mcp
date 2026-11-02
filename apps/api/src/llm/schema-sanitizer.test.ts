import { describe, expect, it } from 'vitest';
import { sanitizeToolSchema as sanitize } from './schema-sanitizer.js';
import type { JsonSchemaObject } from './types.js';
describe('tool schema sanitizer', () => {
  it('resolves escaped local refs and nullable nested properties without mutation', () => {
    const schema: JsonSchemaObject = {
      $schema: 'schema',
      $id: 'id',
      type: 'object',
      additionalProperties: false,
      $defs: { 'a/b': { type: 'string', minLength: 1 } },
      properties: {
        nested: {
          type: 'object',
          properties: { x: { anyOf: [{ $ref: '#/$defs/a~1b' }, { type: 'null' }] } },
          required: ['x'],
        },
      },
      required: ['nested'],
    };
    const before = structuredClone(schema);
    expect(sanitize(schema, 'ollama')).toEqual({
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: { x: { type: 'string', minLength: 1 } },
          required: [],
        },
      },
      required: ['nested'],
    });
    expect(schema).toEqual(before);
  });
  it('handles arrays, nullable enums and type arrays deterministically', () => {
    const schema: JsonSchemaObject = {
      type: 'object',
      properties: {
        z: { type: ['integer', 'null'] },
        a: {
          type: 'array',
          items: { type: 'object', properties: {}, additionalProperties: false },
        },
        e: { type: 'string', enum: [null, 'a'], default: 'a' },
      },
      required: ['z', 'e', 'a'],
    };
    const output = sanitize(schema, 'openai');
    expect(output.required).toEqual(['a']);
    expect(JSON.stringify(output)).toBe(
      JSON.stringify(sanitize(JSON.parse(JSON.stringify(schema)) as JsonSchemaObject, 'openai')),
    );
    expect(
      sanitize({ properties: { b: { type: 'string' }, a: { type: 'number' } } }, 'anthropic'),
    ).toEqual(
      sanitize({ properties: { a: { type: 'number' }, b: { type: 'string' } } }, 'anthropic'),
    );
  });
  it.each([
    {
      type: 'object',
      properties: { x: { $ref: '#/$defs/x' } },
      $defs: { x: { $ref: '#/$defs/x' } },
    },
    { $ref: 'https://example.com/schema' },
    { $ref: '#/missing' },
    { type: 'string' },
    { type: 'object', allOf: [{ type: 'object' }] },
    { type: 'object', properties: {}, required: ['missing'] },
    {
      type: 'object',
      properties: { x: { $ref: '#/$defs/x', type: 'number' } },
      $defs: { x: { type: 'string' } },
    },
  ])('rejects invalid/unsupported constraints', (schema) => {
    expect(() => sanitize(schema as JsonSchemaObject, 'ollama')).toThrow();
  });
  it('keeps general unions only in compatible profiles', () => {
    const schema = {
      type: 'object',
      properties: { x: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    };
    expect(() => sanitize(schema, 'ollama')).toThrow();
    expect(sanitize(schema, 'anthropic').properties).toEqual(schema.properties);
    expect(
      sanitize({ type: 'object', additionalProperties: false }, 'openai').additionalProperties,
    ).toBe(false);
    expect(sanitize({}, 'ollama')).toEqual({ type: 'object', properties: {}, required: [] });
  });
});
