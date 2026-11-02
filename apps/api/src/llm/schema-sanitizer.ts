import { LLMError } from './errors.js';
import type { JsonSchemaObject, JsonValue } from './types.js';
export type SchemaProfile = 'ollama' | 'openai' | 'anthropic';
const annotations = new Set([
  '$schema',
  '$id',
  '$defs',
  'definitions',
  'default',
  'examples',
  'example',
  'readOnly',
  'writeOnly',
  'deprecated',
  'title',
  '$comment',
]);
const scalars = new Set([
  'type',
  'description',
  'enum',
  'const',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
]);
function object(value: JsonValue | undefined): value is JsonSchemaObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalid(): never {
  throw new LLMError(
    'bad_request',
    'Tool schema contains unsupported, cyclic, or invalid constraints',
    false,
  );
}
function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key]!)]),
    );
  return value;
}
export function sanitizeToolSchema(
  schema: JsonSchemaObject,
  profile: SchemaProfile,
): JsonSchemaObject {
  const visit = (
    input: JsonSchemaObject,
    refs: ReadonlySet<string>,
  ): { schema: JsonSchemaObject; nullable: boolean } => {
    let source = input;
    if ('$ref' in source) {
      const ref = source.$ref;
      if (typeof ref !== 'string' || !ref.startsWith('#/') || refs.has(ref)) invalid();
      let target: JsonValue | undefined = schema;
      for (const segment of ref.slice(2).split('/')) {
        if (!object(target)) invalid();
        const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
        if (!Object.hasOwn(target, key)) invalid();
        target = target[key];
      }
      if (!object(target)) invalid();
      const siblings = Object.fromEntries(Object.entries(source).filter(([key]) => key !== '$ref'));
      for (const [key, value] of Object.entries(siblings))
        if (
          key in target &&
          JSON.stringify(canonical(target[key]!)) !== JSON.stringify(canonical(value))
        )
          invalid();
      return visit({ ...target, ...siblings }, new Set([...refs, ref]));
    }
    let nullable = false;
    for (const union of ['anyOf', 'oneOf'] as const) {
      const branches = source[union];
      if (branches === undefined) continue;
      if (!Array.isArray(branches) || !branches.length || !branches.every(object)) invalid();
      const nonNull = branches.filter((branch) => branch.type !== 'null');
      if (nonNull.length === 1 && branches.length > nonNull.length) {
        const rest = Object.fromEntries(Object.entries(source).filter(([key]) => key !== union));
        const branch = nonNull[0]!;
        for (const [key, value] of Object.entries(rest))
          if (
            key in branch &&
            JSON.stringify(canonical(branch[key]!)) !== JSON.stringify(canonical(value))
          )
            invalid();
        const flattened = visit({ ...branch, ...rest }, refs);
        return { schema: flattened.schema, nullable: true };
      } else if (profile === 'ollama') invalid();
    }
    if (Array.isArray(source.type) && source.type.includes('null')) {
      const types = source.type.filter((entry) => entry !== 'null');
      if (types.length !== 1) invalid();
      source = { ...source, type: types[0]! };
      nullable = true;
    }
    const result: JsonSchemaObject = {};
    const optional = new Set<string>();
    for (const [key, value] of Object.entries(source)) {
      if (annotations.has(key)) continue;
      if (key === 'properties') {
        if (!object(value)) invalid();
        result.properties = Object.fromEntries(
          Object.entries(value).map(([name, child]) => {
            if (!object(child)) invalid();
            const mapped = visit(child, refs);
            if (mapped.nullable) optional.add(name);
            return [name, mapped.schema];
          }),
        );
      } else if (key === 'items') {
        if (!object(value)) invalid();
        result.items = visit(value, refs).schema;
      } else if (key === 'required') {
        if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) invalid();
        result.required = [...new Set(value)].sort();
      } else if (key === 'additionalProperties') {
        if (typeof value !== 'boolean') invalid();
        if (profile !== 'ollama') result[key] = value;
      } else if (key === 'anyOf' || key === 'oneOf') {
        if (!Array.isArray(value) || !value.every(object)) invalid();
        result[key] = value.map((branch) => visit(branch, refs).schema);
      } else if (scalars.has(key)) result[key] = structuredClone(value);
      else invalid();
    }
    if (Array.isArray(result.enum) && result.enum.includes(null)) {
      result.enum = result.enum.filter((value) => value !== null);
      nullable = true;
      if (!result.enum.length) invalid();
    }
    if (result.type === 'object' || result.properties !== undefined) {
      result.type = 'object';
      result.properties ??= {};
      const required = (result.required ?? []) as string[];
      const properties = result.properties;
      if (!object(properties) || required.some((key) => !Object.hasOwn(properties, key))) invalid();
      result.required = required.filter((key) => !optional.has(key));
    }
    return { schema: canonical(result) as JsonSchemaObject, nullable };
  };
  const result = visit(schema, new Set()).schema;
  if (
    result.type === undefined &&
    result.properties === undefined &&
    !('anyOf' in result) &&
    !('oneOf' in result)
  ) {
    result.type = 'object';
    result.properties = {};
    result.required = [];
  }
  if (result.type !== 'object') invalid();
  return canonical(result) as JsonSchemaObject;
}
