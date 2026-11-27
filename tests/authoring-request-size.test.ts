import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePlan } from '../src/authoring/index.js';
import { planSchema, ursSchema, type Plan, type Urs } from '../src/schema.js';
import type { ContextBundle } from '../src/context.js';
import { providerOutputText } from './provider-fixture.js';
import { questionAnswerHash } from '../src/urs.js';

vi.mock('../src/authoring/discovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/authoring/discovery.js')>()),
  Discovery: class {
    async open() {
      return {
        url: 'https://example.test/',
        title: 'Synthetic sample register',
        text: 'Sample ID',
        controls: [{ label: 'Sample ID', type: 'text' }],
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

function text(label: string, length: number) {
  const clause = `${label}: preserve the complete reviewed condition and independently derived expected values. `;
  return `${clause.repeat(Math.ceil(length / clause.length)).slice(0, length)} ${label}-FINAL-CLAUSE`;
}

/** Similar in size to the user's retained ten-case protocol. All prose and fixtures
 * are synthetic; the test must retain every byte rather than truncate requirements. */
function largeRevision(): {
  urs: Urs;
  plan: Plan;
  fixtures: { path: string; content: string }[];
  context: ContextBundle;
} {
  const humanInstruction = 'A human must perform the physical sample inspection.';
  const urs = ursSchema.parse({
    schema_version: 1,
    document: {
      id: 'URS-LARGE',
      revision: '1',
      title: 'Detailed sample qualification',
      intended_use: 'Retain a complete reviewed synthetic sample qualification specification.',
    },
    families: [
      {
        id: 'records',
        title: 'Records',
        requirements: Array.from({ length: 10 }, (_, index) => ({
          id: `R-${index + 1}`,
          title: `Record condition ${index + 1}`,
          statement: `${index < 5 ? humanInstruction : 'The form shall show the Sample ID field.'} ${text(`REQUIREMENT-${index + 1}`, 2500)}`,
        })),
      },
    ],
  });
  urs.open_questions.push({
    id: 'Q-LABEL',
    requirement: 'R-6',
    question: 'Which observable label should the automated check verify?',
    answer: 'Verify the visible Sample ID field by its accessible label.',
  });
  const acceptedQuestion = urs.open_questions[0];
  acceptedQuestion.resolution = {
    answer_hash: questionAnswerHash(acceptedQuestion),
    applied_at: '2026-11-26T12:00:00.000Z',
    targets: ['requirement:R-6'],
    decision: {
      authority: 'delegated',
      basis: 'implementation',
      rationale: `The source shows the accessible label. ${text('ACCEPTED-DECISION-RATIONALE', 1500)}`,
      citations: [{ source: 'source-1', location: 'app.html' }],
      original_answer: 'Make the call from the supplied context.',
    },
  };
  const plan = planSchema.parse({
    schema_version: 1,
    runtime_version: 1,
    id: 'IOQ-LARGE',
    title: 'Reviewed sample protocol',
    urs_revision: '1',
    target: { url: 'https://example.test/', allowed_origins: ['https://example.test'] },
    environment: {},
    fixtures: ['fixtures/derivations.txt'],
    obligations: Array.from({ length: 10 }, (_, index) => ({
      id: `OB-${index + 1}`,
      requirement_id: `R-${index + 1}`,
      source: `R-${index + 1}/statement`,
      statement: text(`OBLIGATION-${index + 1}`, 600),
      ...(index < 5
        ? { manual_case_ids: [`OQ-${index + 1}`] }
        : { assertion_ids: [`A-${index + 1}`] }),
    })),
    questions: [
      {
        id: 'PREP-1',
        kind: 'execution_preparation',
        requirement: 'R-1',
        case_ids: ['OQ-1'],
        question: 'Prepare the independently supplied reference material for physical inspection.',
      },
    ],
    cases: Array.from({ length: 10 }, (_, index) => ({
      id: `OQ-${index + 1}`,
      title: `Case ${index + 1}`,
      classification: 'OQ',
      requirements: [`R-${index + 1}`],
      ...(index < 5
        ? {
            manual: true,
            prerequisites: [text(`PREREQUISITE-${index + 1}`, 500)],
            manual_procedure: text(`PROCEDURE-${index + 1}`, 4000),
            manual_expected: text(`MANUAL-EXPECTED-${index + 1}`, 800),
            manual_reason: {
              kind: 'explicit_manual_requirement',
              requirement_id: `R-${index + 1}`,
              source: `R-${index + 1}/statement`,
              supporting_quote: humanInstruction,
              dependency: 'physical sample inspection',
              explanation:
                'The reviewed specification explicitly requires a physical inspection by a person.',
            },
            steps: [],
          }
        : {
            steps: [
              {
                id: '01',
                instruction: text(`PROCEDURE-${index + 1}`, 1400),
                actions: [{ op: 'navigate', url: '/' }],
                assertions: [
                  {
                    id: `A-${index + 1}`,
                    locator: { by: 'label', value: 'Sample ID' },
                    read: 'visible',
                    comparison: 'equals',
                    expected: true,
                  },
                ],
                evidence: [{ id: `E-${index + 1}`, kind: 'observation' }],
              },
            ],
          }),
    })),
  });
  return {
    urs,
    plan,
    fixtures: [{ path: 'fixtures/derivations.txt', content: text('INDEPENDENT-DERIVATION', 4000) }],
    context: {
      passages: [
        { source: 'source-1', location: 'app.html', text: text('HTML-CONTEXT', 12000) },
        { source: 'source-1', location: 'app.js', text: text('JAVASCRIPT-CONTEXT', 12000) },
      ],
      hashes: [],
      warnings: [],
    },
  };
}

function atPointer(value: unknown, pointer: string): unknown {
  expect(pointer).toMatch(/^\/(?:candidate|urs)\//);
  return pointer
    .slice(1)
    .split('/')
    .reduce<unknown>((node, encoded) => {
      const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
      return node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined;
    }, value);
}

const scenarios = (['openai', 'anthropic'] as const).flatMap((provider) => [
  { provider, correction: false },
  { provider, correction: true },
]);
it.each(scenarios)(
  'revises and reviews a realistic large protocol through $provider (correction=$correction) without duplicating or truncating it',
  async ({ provider, correction }) => {
    const root = await mkdtemp(join(tmpdir(), 'provenarium large revision '));
    roots.push(root);
    const fixture = largeRevision();
    const before = structuredClone(fixture);
    const rejectedProposal = {
      edits: [
        {
          op: 'update_instruction',
          case_id: 'OQ-6',
          step_id: 'UNKNOWN-STEP',
          instruction: 'Retain the expected behavior while fixing this target.',
        },
      ],
    };
    const outputs: unknown[] = [
      { action: 'finish' },
      ...(correction ? [rejectedProposal] : []),
      { edits: [] },
    ];
    const requests: { bytes: number; input: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, options?: RequestInit) => {
      const encoded = String(options?.body);
      const body = JSON.parse(encoded);
      requests.push({
        bytes: Buffer.byteLength(encoded),
        input: JSON.parse(
          provider === 'openai' ? body.input[0].content[0].text : body.messages[0].content,
        ),
      });
      const value = outputs.shift();
      if (value === undefined) throw new Error('Unexpected provider request.');
      const resultText = providerOutputText(options, value);
      return new Response(
        JSON.stringify(
          provider === 'openai'
            ? {
                status: 'completed',
                usage: { input_tokens: 100, output_tokens: 50 },
                output: [{ type: 'message', content: [{ type: 'output_text', text: resultText }] }],
              }
            : {
                stop_reason: 'end_turn',
                usage: { input_tokens: 100, output_tokens: 50 },
                content: [{ type: 'text', text: resultText }],
              },
        ),
      );
    });
    const result = await generatePlan({
      root,
      provider,
      key: 'synthetic-provider-key',
      thoroughness: 'quick',
      maxSpend: 15,
      urs: fixture.urs,
      existing: fixture.plan,
      existingUrs: fixture.urs,
      existingFixtures: fixture.fixtures,
      context: fixture.context,
      url: fixture.plan.target.url,
      feedback: 'Retain every reviewed criterion and inspect executable validity.',
      allowManual: true,
      fetchImpl,
    });
    expect(result.incomplete, result.questions.join('\n')).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(correction ? 3 : 2);
    expect(outputs).toEqual([]);
    expect(requests.every((request) => request.bytes <= 200000)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(fixture.plan))).toBeGreaterThan(45000);
    expect(Buffer.byteLength(JSON.stringify(fixture.urs))).toBeGreaterThan(27000);
    for (const { input } of requests) {
      expect(input.urs).toEqual(before.urs);
      const ledger = input.accepted_decisions as Record<string, unknown>[];
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        question_id: 'Q-LABEL',
        authority: 'delegated',
        basis: 'implementation',
        requirement_ids: ['R-6'],
        question_pointer: '/urs/open_questions/0/question',
        decision_pointer: '/urs/open_questions/0/answer',
        resolution_pointer: '/urs/open_questions/0/resolution',
      });
      expect(atPointer(input, ledger[0].question_pointer as string)).toBe(
        before.urs.open_questions[0].question,
      );
      expect(atPointer(input, ledger[0].decision_pointer as string)).toBe(
        before.urs.open_questions[0].answer,
      );
      expect(atPointer(input, ledger[0].resolution_pointer as string)).toEqual(
        before.urs.open_questions[0].resolution,
      );
      expect(ledger[0]).not.toHaveProperty('decision');
      expect(ledger[0]).not.toHaveProperty('rationale');
    }
    for (const { input } of requests.slice(1)) {
      expect(input).not.toHaveProperty('existing');
      expect(input.urs).toEqual(before.urs);
      expect(input.context).toEqual(before.context);
      expect(input.candidate).toEqual({ plan: before.plan, fixtures: before.fixtures });
    }
    for (const { input } of requests.filter(({ input }) => input.edit_catalog)) {
      const catalog = input.edit_catalog as {
        automatable_cases: Record<string, unknown>[];
        manual_justification_cases: {
          id: string;
          sources: { source: string; requirement_id: string }[];
        }[];
      };
      expect(catalog.automatable_cases.map((item) => item.id)).toEqual(
        before.plan.cases.filter((item) => item.manual).map((item) => item.id),
      );
      let pointers = 0;
      const verifyPointers = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
          if (key.endsWith('_pointer')) {
            expect(typeof child).toBe('string');
            const original = atPointer(
              { candidate: { plan: before.plan, fixtures: before.fixtures } },
              child as string,
            );
            expect(original).toBeDefined();
            expect(atPointer(input, child as string)).toEqual(original);
            pointers++;
          } else verifyPointers(child);
        }
      };
      verifyPointers(catalog);
      expect(pointers).toBeGreaterThanOrEqual(21);
      for (const item of catalog.automatable_cases) {
        const original = before.plan.cases.find((candidate) => candidate.id === item.id)!;
        expect(atPointer(input, item.manual_procedure_pointer as string)).toBe(
          original.manual_procedure,
        );
        expect(atPointer(input, item.preserved_manual_expected_pointer as string)).toBe(
          original.manual_expected,
        );
        expect(atPointer(input, item.prerequisites_pointer as string)).toEqual(
          original.prerequisites,
        );
        expect(item).not.toHaveProperty('manual_procedure');
        expect(item).not.toHaveProperty('preserved_manual_expected');
      }
      for (const item of catalog.manual_justification_cases) {
        const original = before.plan.cases.find((candidate) => candidate.id === item.id)!;
        expect(item.sources).toEqual(
          original.requirements.map((requirement_id) => ({
            requirement_id,
            source: `${requirement_id}/statement`,
          })),
        );
      }
    }
    if (correction) {
      expect(requests[2].input.rejected_proposal).toEqual(rejectedProposal);
      expect((requests[2].input.validation_errors as string[]).join(' ')).toContain(
        'Unknown step OQ-6/UNKNOWN-STEP',
      );
      expect(JSON.stringify(result.diagnostics)).toContain('UNKNOWN-STEP');
    }
    expect(result.value).toEqual({ plan: before.plan, fixtures: before.fixtures });
    expect(fixture).toEqual(before);
  },
);
