import { z } from 'zod';

export type StructuredProvider = 'openai' | 'anthropic';
type JsonSchema = Record<string, any>;
const OMIT = '[provenarium:omit-null]';
const PRESENCE = '[provenarium:presence]';
const MAP = '[provenarium:map]';
const JSON_VALUE = '[provenarium:json-value]';
const ROOT = '[provenarium:root]';
const JSON_GRAPH = '[provenarium:json-graph]';
const SCALAR: JsonSchema = {
  anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
};
const KINDS = ['string', 'number', 'boolean', 'null', 'array', 'object'];
const MAX_JSON_NODES = 10000;
const MAX_JSON_DEPTH = 32;

function annotation(schema: JsonSchema, marker: string, guidance: string): JsonSchema {
  return {
    ...schema,
    description: `${marker} ${guidance}${schema.description ? ` ${schema.description}` : ''}`,
  };
}
function marked(schema: JsonSchema, marker: string): boolean {
  return typeof schema.description === 'string' && schema.description.includes(marker);
}
function resolve(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const visited = new Set<string>();
  while (schema.$ref) {
    if (!schema.$ref.startsWith('#/$defs/') || visited.has(schema.$ref))
      throw new Error('Unsupported or recursive structured-output reference.');
    visited.add(schema.$ref);
    const name = schema.$ref.slice('#/$defs/'.length).replaceAll('~1', '/').replaceAll('~0', '~');
    const target = root.$defs?.[name];
    if (!target) throw new Error('Missing structured-output definition.');
    schema = {
      ...target,
      ...(schema.description
        ? { description: `${schema.description} ${target.description ?? ''}` }
        : {}),
    };
  }
  return schema;
}
function scalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}
function naturalJson(value: unknown): boolean {
  return (
    scalar(value) ||
    (Array.isArray(value) &&
      (value.every(scalar) || value.every((row) => Array.isArray(row) && row.every(scalar))))
  );
}
function issue(path: PropertyKey[], message: string): never {
  throw new z.ZodError([{ code: 'custom', path, message }]);
}
function pointer(parts: string[]): string {
  return parts.map((part) => '/' + part.replaceAll('~', '~0').replaceAll('/', '~1')).join('');
}
function encodeGraph(value: unknown): unknown {
  const paths: string[] = [],
    kinds: string[] = [],
    values: unknown[] = [];
  const walk = (item: unknown, parts: string[]) => {
    if (paths.length >= MAX_JSON_NODES || parts.length > MAX_JSON_DEPTH)
      throw new Error('Structured JSON value exceeds the bounded node or depth limit.');
    const kind = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
    if (!KINDS.includes(kind) || (kind === 'number' && !Number.isFinite(item)))
      throw new Error('Structured JSON values must contain only finite JSON data.');
    paths.push(pointer(parts));
    kinds.push(kind);
    values.push(kind === 'array' || kind === 'object' ? null : item);
    if (Array.isArray(item)) item.forEach((child, index) => walk(child, [...parts, String(index)]));
    else if (item && typeof item === 'object')
      for (const [key, child] of Object.entries(item)) walk(child, [...parts, key]);
  };
  walk(value, []);
  return { paths, kinds, values };
}
function decodeGraph(value: any, path: PropertyKey[]): unknown {
  if (
    !value ||
    !Array.isArray(value.paths) ||
    !Array.isArray(value.kinds) ||
    !Array.isArray(value.values)
  )
    issue(path, 'Compound JSON needs parallel paths, kinds, and values arrays.');
  if (
    !value.paths.length ||
    value.paths.length > MAX_JSON_NODES ||
    value.paths.length !== value.kinds.length ||
    value.paths.length !== value.values.length
  )
    issue(path, 'Compound JSON arrays must have equal nonzero lengths within the node limit.');
  const nodes = new Map<string, unknown>();
  let result: unknown;
  for (let index = 0; index < value.paths.length; index++) {
    const rawPath = value.paths[index];
    if (
      typeof rawPath !== 'string' ||
      (rawPath !== '' && !rawPath.startsWith('/')) ||
      /~(?![01])/u.test(rawPath)
    )
      issue([...path, 'paths', index], 'Expected a canonical JSON pointer.');
    const parts =
      rawPath === ''
        ? []
        : rawPath
            .slice(1)
            .split('/')
            .map((part: string) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    if (
      parts.length > MAX_JSON_DEPTH ||
      nodes.has(rawPath) ||
      (index === 0 && rawPath !== '') ||
      (index > 0 && rawPath === '')
    )
      issue(
        [...path, 'paths', index],
        'Compound JSON needs one root, unique paths, and bounded depth.',
      );
    const kind = value.kinds[index],
      item = value.values[index];
    if (
      !KINDS.includes(kind) ||
      (['array', 'object', 'null'].includes(kind) ? item !== null : typeof item !== kind) ||
      (kind === 'number' && !Number.isFinite(item))
    )
      issue([...path, 'values', index], 'Compound JSON value does not match its declared kind.');
    const decoded = kind === 'array' ? [] : kind === 'object' ? {} : item;
    if (!parts.length) result = decoded;
    else {
      const key = parts.at(-1)!;
      const parent = nodes.get(pointer(parts.slice(0, -1)));
      if (Array.isArray(parent)) {
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) !== parent.length)
          issue([...path, 'paths', index], 'Array children must use consecutive indexes in order.');
        parent.push(decoded);
      } else if (parent && typeof parent === 'object') {
        if (Object.hasOwn(parent, key)) issue([...path, 'paths', index], 'Duplicate object entry.');
        Object.defineProperty(parent, key, {
          value: decoded,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } else
        issue([...path, 'paths', index], 'Child paths must follow an existing container parent.');
    }
    nodes.set(rawPath, decoded);
  }
  return result;
}
function genericJson(): JsonSchema {
  const graph = annotation(
    {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
        kinds: { type: 'array', items: { type: 'string', enum: KINDS } },
        values: { type: 'array', items: SCALAR },
      },
      required: ['paths', 'kinds', 'values'],
      additionalProperties: false,
    },
    JSON_GRAPH,
    'For compound JSON not expressible as scalars/flat arrays/matrices, list nodes in parent-before-child order. paths are JSON pointers (root empty); kinds identify each node; values hold scalar data or null for containers. Arrays use consecutive indexes. All three arrays have equal length, at most 10000 nodes and depth 32.',
  );
  return annotation(
    {
      anyOf: [
        ...SCALAR.anyOf,
        { type: 'array', items: SCALAR },
        { type: 'array', items: { type: 'array', items: SCALAR } },
        graph,
      ],
    },
    JSON_VALUE,
    'Use natural JSON scalars, flat scalar arrays, or scalar matrices directly. Use the typed compound representation only for objects or more deeply nested containers.',
  );
}
function isRecursiveJson(schema: JsonSchema, self: string): boolean {
  if (!Array.isArray(schema.anyOf) || schema.anyOf.length !== 6) return false;
  const branches = schema.anyOf;
  return (
    ['string', 'number', 'boolean', 'null'].every((type) =>
      branches.some((branch: JsonSchema) => branch.type === type),
    ) &&
    branches.some((branch: JsonSchema) => branch.type === 'array' && branch.items?.$ref === self) &&
    branches.some(
      (branch: JsonSchema) =>
        branch.type === 'object' && branch.additionalProperties?.$ref === self,
    )
  );
}
function allowsNull(schema: JsonSchema, root: JsonSchema, seen = new Set<string>()): boolean {
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return false;
    seen.add(schema.$ref);
    return allowsNull(resolve(schema, root), root, seen);
  }
  return (
    schema.type === 'null' ||
    (Array.isArray(schema.type) && schema.type.includes('null')) ||
    schema.const === null ||
    schema.enum?.includes(null) ||
    schema.anyOf?.some((branch: JsonSchema) => allowsNull(branch, root, new Set(seen))) ||
    false
  );
}
function nullable(schema: JsonSchema): JsonSchema {
  return { anyOf: [schema, { type: 'null' }] };
}
function matches(schema: JsonSchema, value: unknown, root: JsonSchema): boolean {
  schema = resolve(schema, root);
  if (marked(schema, JSON_VALUE))
    return naturalJson(value) || Boolean(value && typeof value === 'object');
  if (schema.anyOf) return schema.anyOf.some((branch: JsonSchema) => matches(branch, value, root));
  if ('const' in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (Array.isArray(schema.type))
    return schema.type.some((type: string) => matches({ ...schema, type }, value, root));
  switch (schema.type) {
    case 'null':
      return value === null;
    case 'string':
      return typeof value === 'string';
    case 'number':
    case 'integer':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value) && value.every((item) => matches(schema.items, item, root));
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      return Object.entries(schema.properties ?? {}).every(
        ([key, child]: [string, any]) =>
          !('const' in child) || (value as Record<string, unknown>)[key] === child.const,
      );
    default:
      return false;
  }
}

/** Encode domain fixtures using the exact native schema captured from a provider request.
 * Invalid scalar values and extra object fields are deliberately preserved for negative tests. */
export function encodeProviderOutput(native: JsonSchema, value: unknown): unknown {
  const walk = (schema: JsonSchema, item: unknown): unknown => {
    schema = resolve(schema, native);
    if (marked(schema, ROOT)) return { result: walk(schema.properties.result, item) };
    if (marked(schema, PRESENCE)) {
      const key = Object.keys(schema.anyOf[1].properties)[0];
      return item === undefined ? { [key]: true } : walk(schema.anyOf[0], item);
    }
    if (marked(schema, OMIT)) {
      if (item === undefined) return null;
      const copy = { ...schema, description: schema.description.replace(OMIT, '') };
      return walk(copy, item);
    }
    if (marked(schema, JSON_VALUE)) return naturalJson(item) ? item : encodeGraph(item);
    if (marked(schema, MAP)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      return {
        entries: Object.entries(item).map(([key, value]) => ({
          key,
          value: walk(schema.properties.entries.items.properties.value, value),
        })),
      };
    }
    if (schema.anyOf) {
      const chosen = schema.anyOf.find((branch: JsonSchema) => matches(branch, item, native));
      return chosen ? walk(chosen, item) : item;
    }
    if (schema.type === 'object' && item && typeof item === 'object' && !Array.isArray(item)) {
      const result: Record<string, unknown> = { ...item };
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (!Object.hasOwn(item, key) && !schema.required?.includes(key)) continue;
        const encoded = walk(child as JsonSchema, (item as Record<string, unknown>)[key]);
        if (encoded !== undefined)
          Object.defineProperty(result, key, {
            value: encoded,
            enumerable: true,
            configurable: true,
            writable: true,
          });
      }
      return result;
    }
    if (schema.type === 'array' && Array.isArray(item))
      return item.map((child) => walk(schema.items, child));
    return item;
  };
  return walk(native, value);
}
function decodeProviderOutput(native: JsonSchema, value: unknown): unknown {
  const branchValidators = new Map<JsonSchema, z.ZodType>();
  const validBranch = (branch: JsonSchema, item: unknown) => {
    let validator = branchValidators.get(branch);
    if (!validator) {
      validator = z.fromJSONSchema({ ...branch, $defs: native.$defs });
      branchValidators.set(branch, validator);
    }
    return validator.safeParse(item).success;
  };
  const walk = (schema: JsonSchema, item: any, path: PropertyKey[]): unknown => {
    schema = resolve(schema, native);
    if (marked(schema, ROOT))
      return walk(schema.properties.result, item.result, [...path, 'result']);
    if (marked(schema, PRESENCE)) {
      const key = Object.keys(schema.anyOf[1].properties)[0];
      if (item && typeof item === 'object' && !Array.isArray(item) && Object.hasOwn(item, key))
        return undefined;
      return walk(schema.anyOf[0], item, path);
    }
    if (marked(schema, OMIT)) {
      if (item === null) return undefined;
      return walk({ ...schema, description: schema.description.replace(OMIT, '') }, item, path);
    }
    if (marked(schema, JSON_VALUE)) return naturalJson(item) ? item : decodeGraph(item, path);
    if (marked(schema, MAP)) {
      const result: Record<string, unknown> = {};
      for (const [index, entry] of item.entries.entries()) {
        if (Object.hasOwn(result, entry.key))
          issue([...path, 'entries', index, 'key'], 'Duplicate map key.');
        Object.defineProperty(result, entry.key, {
          value: walk(schema.properties.entries.items.properties.value, entry.value, [
            ...path,
            'entries',
            index,
            'value',
          ]),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    }
    if (schema.anyOf) {
      const chosen = schema.anyOf.find((branch: JsonSchema) => validBranch(branch, item));
      return chosen ? walk(chosen, item, path) : item;
    }
    if (schema.type === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (!Object.hasOwn(item, key) && !schema.required?.includes(key)) continue;
        const decoded = walk(child as JsonSchema, item[key], [...path, key]);
        if (decoded !== undefined)
          Object.defineProperty(result, key, {
            value: decoded,
            enumerable: true,
            configurable: true,
            writable: true,
          });
      }
      return result;
    }
    if (schema.type === 'array')
      return item.map((child: unknown, index: number) =>
        walk(schema.items, child, [...path, index]),
      );
    return item;
  };
  return walk(native, value, []);
}

/** Validate the strict shared subset before reserving budget or dispatching. */
export function assertProviderSchemaLimits(
  native: JsonSchema,
  provider: StructuredProvider = 'openai',
): void {
  let properties = 0,
    enums = 0,
    chars = 0,
    optional = 0,
    unions = 0;
  const visit = (node: JsonSchema) => {
    if (provider === 'openai' && node.$ref && Object.keys(node).length !== 1)
      throw new Error('OpenAI schema references must not contain sibling keywords.');
    if (node.anyOf || Array.isArray(node.type)) unions++;
    if (node.type === 'object') {
      const keys = Object.keys(node.properties ?? {});
      properties += keys.length;
      optional += keys.filter((key) => !node.required?.includes(key)).length;
      chars += keys.join('').length;
      if (
        node.additionalProperties !== false ||
        (provider === 'openai' && keys.some((key) => !node.required?.includes(key)))
      )
        throw new Error('Native objects must be closed and require every property.');
    }
    if (node.enum) {
      enums += node.enum.length;
      const size = node.enum.map(String).join('').length;
      chars += size;
      if (node.enum.length > 250 && size > 15000)
        throw new Error('Native enum exceeds its string limit.');
    }
    if ('const' in node) chars += String(node.const).length;
    for (const [name, definition] of Object.entries(node.$defs ?? {})) {
      chars += name.length;
      visit(definition as JsonSchema);
    }
    for (const child of Object.values(node.properties ?? {})) visit(child as JsonSchema);
    if (node.items) visit(node.items);
    for (const branch of node.anyOf ?? []) visit(branch);
  };
  visit(native);
  if (provider === 'anthropic' && (optional > 24 || unions > 16))
    throw new Error(
      `Anthropic schema exceeds its 24 optional-field or 16 union limits (${optional} optional, ${unions} unions).`,
    );
  if (properties > 5000 || enums > 1000 || chars > 120000)
    throw new Error('Native schema exceeds supported size limits.');
  const depth = (node: JsonSchema, count: number, stack: Set<string>) => {
    if (node.$ref) {
      if (stack.has(node.$ref)) throw new Error('Recursive native schemas are unsupported.');
      return depth(resolve(node, native), count, new Set([...stack, node.$ref]));
    }
    if (node.type === 'object' || node.type === 'array') count++;
    if (count > 10) throw new Error('Native schema exceeds ten levels of nesting.');
    for (const child of Object.values(node.properties ?? {}))
      depth(child as JsonSchema, count, stack);
    if (node.items) depth(node.items, count, stack);
    for (const branch of node.anyOf ?? []) depth(branch, count, stack);
  };
  depth(native, 0, new Set());
}

/** Compile the local contract to the shared, nonrecursive strict provider subset.
 * Domain fields stay typed; only arbitrary-key maps and JSON compound values need adapters. */
export function compileStructuredOutput<T>(schema: z.ZodType<T>, provider: StructuredProvider) {
  const original = z.toJSONSchema(schema, {
    io: 'input',
    cycles: 'ref',
    reused: 'ref',
    unrepresentable: 'throw',
  }) as JsonSchema;
  const definitions: Record<string, JsonSchema> = {};
  const building = new Set<string>();
  const omissionDefinitions = new Map<string, string>();
  const shareOmission = (node: JsonSchema): JsonSchema => {
    const canonical = JSON.stringify(node);
    let name = omissionDefinitions.get(canonical);
    if (!name) {
      let index = omissionDefinitions.size;
      do name = `__provenarium_optional_${index++}`;
      while (name in definitions || name in (original.$defs ?? {}));
      omissionDefinitions.set(canonical, name);
      definitions[name] = node;
    }
    return { $ref: `#/$defs/${name}` };
  };
  // Claude caps both optional properties and unions. Spending its native optional
  // slots on the first fields encountered wastes them on repeated scalar shapes:
  // those can share one omission union. Keep the least frequent optional shapes
  // native so new action variants do not exceed the union limit merely by order.
  const optionalShapes = new Map<string, number>();
  const visitedDefinitions = new Set<string>();
  const collectOptional = (node: JsonSchema) => {
    if (node.$ref) {
      if (node.$ref === '#')
        throw new Error('Recursive domain schemas are not supported for authoring.');
      if (visitedDefinitions.has(node.$ref)) return;
      visitedDefinitions.add(node.$ref);
      const target = resolve(node, original);
      if (!isRecursiveJson(target, node.$ref)) collectOptional(target);
      return;
    }
    for (const [key, child] of Object.entries(node.properties ?? {}) as [string, JsonSchema][]) {
      if (!node.required?.includes(key)) {
        const shape = JSON.stringify(child);
        optionalShapes.set(shape, (optionalShapes.get(shape) ?? 0) + 1);
      }
      collectOptional(child);
    }
    if (node.items) collectOptional(node.items);
    if (node.additionalProperties && typeof node.additionalProperties === 'object')
      collectOptional(node.additionalProperties);
    for (const branch of node.anyOf ?? node.oneOf ?? []) collectOptional(branch);
  };
  const nativeOptionalShapes = new Set<string>();
  let remainingOptionalSlots = 24;
  if (provider === 'anthropic') {
    collectOptional(original);
    for (const [shape, count] of [...optionalShapes].sort((a, b) => a[1] - b[1]))
      if (count <= remainingOptionalSlots) {
        nativeOptionalShapes.add(shape);
        remainingOptionalSlots -= count;
      }
  }
  const transform = (source: JsonSchema): JsonSchema => {
    if (!source || typeof source !== 'object' || Array.isArray(source))
      throw new Error('Unsupported structured-output schema node.');
    if (source.$ref) {
      if (source.$ref === '#')
        throw new Error('Recursive domain schemas are not supported for authoring.');
      if (!source.$ref.startsWith('#/$defs/'))
        throw new Error('External structured-output references are not supported.');
      const name = source.$ref.slice('#/$defs/'.length);
      if (!(name in definitions)) {
        const target = original.$defs?.[name];
        if (!target) throw new Error('Missing local structured-output definition.');
        if (isRecursiveJson(target, source.$ref)) definitions[name] = genericJson();
        else {
          if (building.has(name))
            throw new Error('Recursive domain schemas are not supported for authoring.');
          building.add(name);
          definitions[name] = transform(target);
          building.delete(name);
        }
      }
      const reference: JsonSchema = {
        $ref: source.$ref,
        ...(source.description ? { description: source.description } : {}),
      };
      // Match the official Python SDK's strict-schema normalization: a described
      // reference becomes its typed target with the field guidance retained.
      // Bare references remain shared, keeping large authoring schemas bounded.
      if (provider === 'openai' && source.description)
        return structuredClone(resolve(reference, { $defs: definitions }));
      return reference;
    }
    const result: JsonSchema = {};
    for (const key of ['description', 'title', 'type', 'enum', 'const'])
      if (source[key] !== undefined) result[key] = source[key];
    if (source.oneOf) {
      const branches = source.oneOf.map((branch: JsonSchema) => resolve(branch, original));
      const discriminated = Object.keys(branches[0]?.properties ?? {}).some((key) => {
        const tags = branches.map((branch: JsonSchema) =>
          branch.required?.includes(key) ? branch.properties?.[key]?.const : undefined,
        );
        return (
          tags.every((tag: unknown) => tag !== undefined) && new Set(tags).size === tags.length
        );
      });
      if (!discriminated)
        throw new Error('Only disjoint discriminated oneOf schemas are supported for authoring.');
      result.anyOf = source.oneOf.map(transform);
      delete result.type;
    } else if (source.anyOf) {
      result.anyOf = source.anyOf.map(transform);
      delete result.type;
    } else if (Array.isArray(source.type)) {
      delete result.type;
      result.anyOf = source.type.map((type: string) => transform({ ...source, type }));
    } else if (source.type === 'object') {
      if (source.additionalProperties && typeof source.additionalProperties === 'object') {
        if (Object.keys(source.properties ?? {}).length)
          throw new Error('Mixed fixed and dynamic object fields are not supported for authoring.');
        return annotation(
          {
            type: 'object',
            properties: {
              entries: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    key: { type: 'string' },
                    value: transform(source.additionalProperties),
                  },
                  required: ['key', 'value'],
                  additionalProperties: false,
                },
              },
            },
            required: ['entries'],
            additionalProperties: false,
          },
          MAP,
          'Represent the object as unique key/value entries.',
        );
      }
      if (source.additionalProperties === true)
        throw new Error('Unconstrained object values are not supported for authoring.');
      result.properties = Object.create(null);
      const required = new Set(source.required ?? []);
      const nativeRequired = new Set(required);
      for (const [key, child] of Object.entries(source.properties ?? {}) as [
        string,
        JsonSchema,
      ][]) {
        let transformed = transform(child);
        const usePlaceholder =
          !required.has(key) &&
          (provider === 'openai' ||
            (!nativeOptionalShapes.has(JSON.stringify(child)) && remainingOptionalSlots-- <= 0));
        if (usePlaceholder) {
          nativeRequired.add(key);
          if (allowsNull(child, original)) {
            let key = '__provenarium_omitted';
            while (JSON.stringify([transformed, definitions]).includes(JSON.stringify(key)))
              key += '_';
            transformed = annotation(
              {
                anyOf: [
                  transformed,
                  {
                    type: 'object',
                    properties: { [key]: { type: 'boolean', const: true } },
                    required: [key],
                    additionalProperties: false,
                  },
                ],
              },
              PRESENCE,
              `Use {"${key}":true} only to omit this optional nullable field. An ordinary null is an intentional value.`,
            );
          } else
            transformed = annotation(
              nullable(transformed),
              OMIT,
              'Use null when this optional field is unused; otherwise supply its typed value.',
            );
          // Anthropic counts union definitions, even identical inline nullable
          // wrappers. Share the complete typed omission contract without erasing
          // field guidance or relaxing the provider's union limit.
          if (provider === 'anthropic') transformed = shareOmission(transformed);
        }
        result.properties[key] = transformed;
      }
      result.required = [...nativeRequired];
      result.additionalProperties = false;
    } else if (source.type === 'array') {
      if (!source.items || Array.isArray(source.items) || source.prefixItems)
        throw new Error('Tuple schemas are not supported for authoring.');
      result.items = transform(source.items);
    } else if (!source.anyOf && !source.type && !('const' in source) && !source.enum) {
      throw new Error('Unconstrained or unsupported authoring schema.');
    }
    const constraints = [
      'minLength',
      'maxLength',
      'pattern',
      'format',
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'multipleOf',
      'minItems',
      'maxItems',
    ];
    const local: string[] = [];
    const formats = new Set([
      'date-time',
      'time',
      'date',
      'duration',
      'email',
      'hostname',
      'ipv4',
      'ipv6',
      'uuid',
      ...(provider === 'anthropic' ? ['uri'] : []),
    ]);
    for (const key of constraints)
      if (source[key] !== undefined) {
        if (
          key === 'format'
            ? formats.has(source[key])
            : provider === 'openai' || (key === 'minItems' && [0, 1].includes(source[key]))
        )
          result[key] = source[key];
        else local.push(`${key}=${JSON.stringify(source[key])}`);
      }
    if (local.length)
      result.description =
        `${result.description ?? ''} Local validation also requires ${local.join(', ')}.`.trim();
    for (const unsupported of [
      'allOf',
      'not',
      'if',
      'then',
      'else',
      'dependentSchemas',
      'patternProperties',
    ])
      if (unsupported in source)
        throw new Error(`Unsupported authoring schema keyword: ${unsupported}.`);
    return result;
  };
  let native = transform(original);
  if (native.type !== 'object' || native.anyOf)
    native = annotation(
      {
        type: 'object',
        properties: { result: native },
        required: ['result'],
        additionalProperties: false,
      },
      ROOT,
      'The result is the typed requested document.',
    );
  if (Object.keys(definitions).length) native.$defs = definitions;
  assertProviderSchemaLimits(native, provider);
  const wireSchema = z.fromJSONSchema(native);
  return {
    schema: native,
    wireSchema,
    encode: (value: unknown) => encodeProviderOutput(native, value),
    decode: (value: unknown) => decodeProviderOutput(native, value),
  };
}
