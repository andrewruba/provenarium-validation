import { providerOutputText } from './provider-fixture.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePlan } from '../src/authoring/index.js';
import { planSchema, ursSchema } from '../src/schema.js';
import { sha256 } from '../src/files.js';

vi.mock('../src/authoring/discovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/authoring/discovery.js')>()),
  Discovery: class {
    async open() {
      return {
        url: 'https://example.test/dilution/',
        title: 'Dilution',
        text: 'Stock volume',
        controls: [],
        links: [],
      };
    }
    async close() {}
  },
}));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'provenarium reference context '));
  roots.push(root);
  await mkdir(join(root, 'references'));
  return root;
}
function urs(references: string[]) {
  return ursSchema.parse({
    schema_version: 1,
    document: {
      id: 'URS',
      revision: '1',
      title: 'Dilution',
      intended_use: 'Verify synthetic dilution calculations',
    },
    families: [
      {
        id: 'calc',
        title: 'Calculation',
        requirements: [
          {
            id: 'URS-CALC',
            title: 'Stock volume',
            statement: 'Show the stock volume from the independent reference calculation.',
            references,
          },
        ],
      },
    ],
  });
}
function candidate(references: string[], generatedFiles: { path: string; content: string }[] = []) {
  return {
    plan: planSchema.parse({
      schema_version: 1,
      runtime_version: 1,
      id: 'PLAN',
      title: 'Dilution protocol',
      urs_revision: '1',
      target: { url: 'https://example.test/dilution/', allowed_origins: ['https://example.test'] },
      environment: {},
      obligations: [
        {
          id: 'OB-1',
          requirement_id: 'URS-CALC',
          source: 'URS-CALC/statement',
          statement: 'Show the independently expected stock volume.',
          assertion_ids: ['A-1'],
        },
      ],
      cases: [
        {
          id: 'OQ-1',
          title: 'Stock result',
          classification: 'OQ',
          requirements: ['URS-CALC'],
          steps: [
            {
              id: 'S-1',
              instruction: 'Compare the stock result.',
              actions: [{ op: 'navigate', url: '/dilution/' }],
              assertions: [
                {
                  id: 'A-1',
                  locator: { by: 'testId', value: 'stock-volume' },
                  read: 'text',
                  comparison: 'equals',
                  expected: '2.000',
                },
              ],
              evidence: [{ id: 'E-1', kind: 'observation' }],
            },
          ],
        },
      ],
      references,
    }),
    fixtures: generatedFiles,
  };
}
function transport(provider: 'openai' | 'anthropic', values: unknown[]) {
  return vi.fn(async (_url: unknown, _options?: RequestInit) => {
    const value = values.shift();
    if (value === undefined) throw new Error('Unexpected provider call');
    const text = providerOutputText(_options, value);
    return new Response(
      JSON.stringify(
        provider === 'openai'
          ? {
              status: 'completed',
              usage: { input_tokens: 100, output_tokens: 50 },
              output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
            }
          : {
              stop_reason: 'end_turn',
              usage: { input_tokens: 100, output_tokens: 50 },
              content: [{ type: 'text', text }],
            },
      ),
    );
  });
}

it.each(['openai', 'anthropic'] as const)(
  'supplies declared independent CSV values and catalog paths to %s authoring',
  async (provider) => {
    const root = await project();
    const reference = 'references/independent-values.csv';
    const csv = 'Stock,Target,Final,Expected stock,Expected diluent\n10,2,10,2.000,8.000\n';
    await writeFile(join(root, reference), csv);
    const requests = transport(provider, [candidate([reference])]);
    const result = await generatePlan({
      root,
      provider,
      key: 'test-key',
      thoroughness: 'quick',
      urs: urs([reference]),
      url: 'https://example.test/dilution/',
      context: { passages: [], hashes: [], warnings: [] },
      fetchImpl: requests,
    });

    expect(result.incomplete, JSON.stringify(result.questions)).toBe(false);
    expect(result.value?.plan.references).toEqual([reference]);
    const body = JSON.parse(requests.mock.calls[0][1]!.body as string);
    const input = JSON.parse(
      provider === 'openai' ? body.input[0].content[0].text : body.messages[0].content,
    );
    expect(input.available_reference_files).toEqual([
      { path: reference, requirements: ['URS-CALC'], sha256: sha256(csv) },
    ]);
    expect(input.context.passages).toContainEqual({
      source: 'normative-input-1',
      location: reference,
      text: csv,
    });
    expect(result.value?.plan.context_hashes).toContainEqual({
      source: 'normative-input-1',
      location: reference,
      sha256: sha256(csv),
    });
  },
);

it('keeps generated derivation fixtures usable as declared plan references', async () => {
  const root = await project();
  const reference = 'fixtures/derived-example.csv';
  const generated = candidate(
    [reference],
    [{ path: reference, content: 'stock,target,final,expected\n10,2,10,2.000\n' }],
  );
  const requests = transport('openai', [generated]);
  const result = await generatePlan({
    root,
    provider: 'openai',
    key: 'test-key',
    thoroughness: 'quick',
    urs: urs([]),
    url: 'https://example.test/dilution/',
    context: { passages: [], hashes: [], warnings: [] },
    fetchImpl: requests,
  });
  expect(result.incomplete, JSON.stringify(result.questions)).toBe(false);
  expect(result.value?.plan.references).toEqual([reference]);
  expect(result.value?.fixtures).toEqual(generated.fixtures);
});

it('stops before provider dispatch when independent reference material is missing', async () => {
  const root = await project();
  const requests = transport('openai', []);
  const result = await generatePlan({
    root,
    provider: 'openai',
    key: 'test-key',
    urs: urs(['references/missing.csv']),
    url: 'https://example.test/dilution/',
    context: { passages: [], hashes: [], warnings: [] },
    fetchImpl: requests,
  });
  expect(result.incomplete).toBe(true);
  expect(result.value).toBeUndefined();
  expect(requests).not.toHaveBeenCalled();
  expect(result.questions.join('\n')).toContain('missing reference references/missing.csv');
});
