import { providerOutputText } from './provider-fixture.js';
import { resolutionProviderValue } from './resolution-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { draftUrs, proposeUrsResolution } from '../src/authoring/index.js';
import { ursSchema } from '../src/schema.js';
import { checkUrs, checkUrsStructure } from '../src/urs.js';
import { applyResolutionProposal } from '../src/urs-resolution.js';

const target = 'https://example.test/dilution/correct/';
vi.mock('../src/authoring/discovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/authoring/discovery.js')>()),
  Discovery: class {
    async open() {
      return {
        url: 'https://example.test/dilution/correct/',
        title: 'Dilution Bench',
        text: 'Before you calculate: final volume must be positive.',
        controls: [],
        links: [],
      };
    }
    async close() {}
  },
}));
const context = {
  passages: [
    {
      source: 'source-1',
      location: 'examples/dilution-app/DEFECTS.md',
      text: 'OQ-ZERO-VOLUME: reject zero final volume with a field-specific error and leave records unchanged.',
    },
  ],
  hashes: [],
  warnings: [],
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporaryProject() {
  const root = await mkdtemp(join(tmpdir(), 'provenarium authored references '));
  roots.push(root);
  return root;
}
function document(references: string[] = []) {
  return ursSchema.parse({
    schema_version: 1,
    document: {
      id: 'URS-DILUTION',
      revision: '1',
      title: 'Dilution Bench',
      intended_use: 'Validate a synthetic dilution calculator.',
    },
    families: [
      {
        id: 'F-INPUT',
        title: 'Input validation',
        requirements: [
          {
            id: 'URS-INPUT-02',
            title: 'Invalid preparations',
            statement: 'Reject a zero final volume without changing saved records.',
            references,
          },
        ],
      },
    ],
    open_questions: [
      {
        id: 'Q-INPUT-03',
        requirement: 'URS-INPUT-02',
        question: 'Should all rejected submissions preserve saved records?',
        answer: null,
      },
    ],
  });
}
function transport(provider: 'openai' | 'anthropic', values: unknown[]) {
  return vi.fn(async (_url: unknown, _options?: RequestInit) => {
    const value = values.shift();
    if (value === undefined) throw new Error('Unexpected provider request');
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
const emptyReview = { findings: [], summary: 'No further findings.' };
function proposal(references: string[]) {
  const value = document(references).families[0].requirements[0];
  value.statement = 'Every rejected input submission shall leave all saved records unchanged.';
  return {
    requirements: [
      { question_ids: ['Q-INPUT-03'], value, reason: 'Apply the recorded integrity decision.' },
    ],
    unresolved: [],
  };
}

describe('authored requirements use the checker reference contract', () => {
  it.each(['openai', 'anthropic'] as const)(
    'normalizes actual model output from %s before the resulting YAML is checked',
    async (provider) => {
      const root = await temporaryProject();
      const proposed = document([
        'OQ-ZERO-VOLUME',
        `Hosted observation: ${target} — Before you calculate`,
      ]);
      const requests = transport(provider, [proposed, emptyReview]);
      const result = await draftUrs({
        root,
        provider,
        key: 'test-key',
        context,
        url: target,
        thoroughness: 'quick',
        fetchImpl: requests,
      });
      expect(result.incomplete).toBe(false);
      const file = join(root, 'urs.yaml');
      await writeFile(file, stringify(result.value));
      const loaded = ursSchema.parse(parse(await readFile(file, 'utf8')));
      expect(await checkUrsStructure(loaded, root)).toEqual([]);
      expect(loaded.families[0].requirements[0]).toMatchObject({
        references: [],
        citations: [
          { source: 'source-1', location: 'examples/dilution-app/DEFECTS.md' },
          { source: '@application', location: target },
        ],
      });
      // Human decisions still block readiness; malformed generated references do not.
      expect(await checkUrs(loaded, root)).toEqual([expect.stringContaining('Q-INPUT-03')]);
      expect(proposed.families[0].requirements[0].references).toHaveLength(2);
      const request = JSON.parse(String(requests.mock.calls[0][1]?.body));
      expect(provider === 'openai' ? request.instructions : request.system).toContain(
        'Use citations for source provenance',
      );
    },
  );

  it('normalizes reference misuse introduced during the review revision as well as the initial draft', async () => {
    const root = await temporaryProject();
    const revised = document([
      `Hosted observation: ${target} — Before you calculate`,
      'OQ-ZERO-VOLUME',
    ]);
    revised.families[0].requirements[0].details = ['Identify Final volume in the error.'];
    const requests = transport('openai', [
      document(),
      {
        findings: [
          {
            requirement: 'URS-INPUT-02',
            severity: 'suggestion',
            message: 'Add the documented error detail.',
          },
        ],
        summary: 'Add error detail.',
      },
      revised,
    ]);
    const result = await draftUrs({
      root,
      provider: 'openai',
      key: 'test-key',
      context,
      url: target,
      thoroughness: 'quick',
      fetchImpl: requests,
    });
    expect(result.incomplete).toBe(false);
    expect(result.reviewRounds).toBe(1);
    expect(result.value!.families[0].requirements[0].references).toEqual([]);
    expect(result.value!.families[0].requirements[0].citations).toHaveLength(2);
    expect(result.value!.families[0].requirements[0].details).toEqual([
      'Identify Final volume in the error.',
    ]);
    expect(await checkUrsStructure(result.value!, root)).toEqual([]);
    expect(requests).toHaveBeenCalledTimes(3);
  });

  it('retains genuine missing normative files as an incomplete diagnostic instead of converting them into citations', async () => {
    const root = await temporaryProject();
    const requests = transport('openai', [document(['references/calculation-examples.csv'])]);
    const result = await draftUrs({
      root,
      provider: 'openai',
      key: 'test-key',
      context,
      thoroughness: 'quick',
      fetchImpl: requests,
    });
    expect(result.incomplete).toBe(true);
    expect(result.value!.families[0].requirements[0].references).toEqual([
      'references/calculation-examples.csv',
    ]);
    expect(result.questions.join('\n')).toContain(
      'missing reference references/calculation-examples.csv',
    );
    expect(requests).toHaveBeenCalledOnce();
  });

  it('preserves an actual normative file even when its name matches a supplied test ID', async () => {
    const root = await temporaryProject();
    await mkdir(join(root, 'references'));
    await writeFile(
      join(root, 'references', 'calculation-examples.csv'),
      'stock,target,volume\n10,2,10\n',
    );
    await writeFile(
      join(root, 'OQ-ZERO-VOLUME'),
      'Independent expected result: reject zero volume.',
    );
    const result = await draftUrs({
      root,
      provider: 'openai',
      key: 'test-key',
      context,
      thoroughness: 'quick',
      fetchImpl: transport('openai', [
        document(['OQ-ZERO-VOLUME', 'references/calculation-examples.csv']),
        emptyReview,
      ]),
    });
    expect(result.incomplete).toBe(false);
    expect(result.value!.families[0].requirements[0].references).toEqual([
      'OQ-ZERO-VOLUME',
      'references/calculation-examples.csv',
    ]);
    expect(result.value!.families[0].requirements[0].citations).toEqual([]);
    expect(await checkUrsStructure(result.value!, root)).toEqual([]);
  });

  it('does not repair a test ID unsupported by the supplied context merely to pass validation', async () => {
    const root = await temporaryProject();
    const result = await draftUrs({
      root,
      provider: 'openai',
      key: 'test-key',
      context,
      thoroughness: 'quick',
      fetchImpl: transport('openai', [document(['OQ-INVENTED'])]),
    });
    expect(result.incomplete).toBe(true);
    expect(result.questions.join()).toContain('missing reference OQ-INVENTED');
    expect(result.value!.families[0].requirements[0].references).toEqual(['OQ-INVENTED']);
  });
});

describe('resolution proposals preserve reference validity', () => {
  it('converts supported test-case provenance before offering a requirement replacement', async () => {
    const root = await temporaryProject();
    const urs = document();
    urs.open_questions[0].answer = 'All rejected inputs must preserve all existing records.';
    const result = await proposeUrsResolution({
      root,
      provider: 'openai',
      key: 'test-key',
      urs,
      context,
      fetchImpl: transport('openai', [resolutionProviderValue(proposal(['OQ-ZERO-VOLUME']))]),
    });
    expect(result.incomplete).toBe(false);
    expect(result.value!.requirements[0].value).toMatchObject({
      references: [],
      citations: [{ source: 'source-1', location: 'examples/dilution-app/DEFECTS.md' }],
    });
    const applied = applyResolutionProposal(urs, result.value);
    expect(await checkUrs(applied, root)).toEqual([]);
    expect(urs.families[0].requirements[0].statement).toBe(
      'Reject a zero final volume without changing saved records.',
    );
    expect(urs.open_questions[0]).not.toHaveProperty('resolution');
  });

  it('rejects a replacement introducing a genuine missing normative file', async () => {
    const root = await temporaryProject();
    const urs = document();
    urs.open_questions[0].answer = 'All rejected inputs must preserve all existing records.';
    const result = await proposeUrsResolution({
      root,
      provider: 'openai',
      key: 'test-key',
      urs,
      context,
      fetchImpl: transport(
        'openai',
        Array.from({ length: 3 }, () =>
          resolutionProviderValue(proposal(['references/independent-reference.csv'])),
        ),
      ),
    });
    expect(result.incomplete).toBe(true);
    expect(result.value).toBeUndefined();
    expect(result.questions.join()).toContain(
      'missing reference references/independent-reference.csv',
    );
    expect(urs.families[0].requirements[0].references).toEqual([]);
  });

  it('does not silently change an unrelated requirement to conceal an existing reference problem', async () => {
    const root = await temporaryProject();
    const urs = document();
    urs.open_questions[0].answer = 'All rejected inputs must preserve all existing records.';
    urs.families[0].requirements.push({
      ...urs.families[0].requirements[0],
      id: 'URS-OTHER',
      references: ['OQ-ZERO-VOLUME'],
    });
    const result = await proposeUrsResolution({
      root,
      provider: 'openai',
      key: 'test-key',
      urs,
      context,
      fetchImpl: transport(
        'openai',
        Array.from({ length: 3 }, () => resolutionProviderValue(proposal([]))),
      ),
    });
    expect(result.incomplete).toBe(true);
    expect(result.value).toBeUndefined();
    expect(result.questions.join()).toContain('URS-OTHER: missing reference OQ-ZERO-VOLUME');
    expect(urs.families[0].requirements[1].references).toEqual(['OQ-ZERO-VOLUME']);
  });
});
