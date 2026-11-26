import { encodeProviderOutput } from '../src/authoring/structured-output.js';

/** Exercise the actual native response schema used by the outgoing API request. */
export function providerOutputText(options: RequestInit | undefined, value: unknown): string {
  const request = JSON.parse(String(options?.body));
  const schema = request.text?.format?.schema ?? request.output_config?.format?.schema;
  if (!schema) throw new Error('The authoring request did not supply a native response schema.');
  if (schema.properties?.payload?.type === 'string')
    throw new Error('Authoring must constrain the document, not an opaque payload string.');
  return JSON.stringify(encodeProviderOutput(schema, value));
}
