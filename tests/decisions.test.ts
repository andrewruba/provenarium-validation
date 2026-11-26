import { expect, it } from 'vitest';
import { acceptedDecisionLedger } from '../src/decisions.js';
import { ursSchema, type ResolutionDecision, type Urs } from '../src/schema.js';
import { applyResolutionProposal } from '../src/urs-resolution.js';
import { questionAnswerHash } from '../src/urs.js';

const decision: ResolutionDecision = {
  authority: 'delegated',
  basis: 'decision',
  rationale: 'The supplied context has no limit; approve this finite test boundary.',
  citations: [],
  original_answer: 'Choose something reasonable.',
};
function accepted(metadata: ResolutionDecision | undefined = decision): Urs {
  const urs = ursSchema.parse({
    schema_version: 1,
    document: { id: 'URS', revision: '1', title: 'Calculator', intended_use: 'Calculate.' },
    families: [
      {
        id: 'f',
        title: 'Calculations',
        requirements: [{ id: 'R1', title: 'Boundary', statement: 'Use the approved boundary.' }],
      },
    ],
    open_questions: [
      {
        id: 'Q1',
        requirement: 'R1',
        question: 'Which finite boundary should be tested?',
        answer: 'Test values up to 1000 and reject greater values.',
      },
    ],
  });
  return applyResolutionProposal(
    urs,
    {
      requirements: [
        {
          question_ids: ['Q1'],
          value: urs.families[0].requirements[0],
          reason: 'Approved boundary.',
        },
      ],
      unresolved: [],
    },
    '2026-11-26T01:00:00.000Z',
    metadata ? new Map([['Q1', metadata]]) : undefined,
  );
}

it('carries concrete accepted decisions and their scope and provenance into the ledger', () => {
  const urs = accepted();
  expect(acceptedDecisionLedger(urs)).toEqual([
    {
      question_id: 'Q1',
      question: 'Which finite boundary should be tested?',
      decision: 'Test values up to 1000 and reject greater values.',
      ...decision,
      targets: ['requirement:R1'],
      requirement_ids: ['R1'],
      applied_at: '2026-11-26T01:00:00.000Z',
    },
  ]);
  const ledger = acceptedDecisionLedger(urs);
  ledger[0].targets.push('document');
  ledger[0].citations.push({ source: 'invented', location: 'nowhere' });
  expect(urs.open_questions[0].resolution?.targets).toEqual(['requirement:R1']);
  expect(urs.open_questions[0].resolution?.decision?.citations).toEqual([]);
});

it('retains legacy acceptance without fabricating delegation or changing its parsed object or hash', () => {
  const urs = accepted();
  delete urs.open_questions[0].resolution!.decision;
  const legacy = JSON.stringify(urs);
  expect(JSON.stringify(ursSchema.parse(urs))).toBe(legacy);
  expect(urs.open_questions[0].resolution!.answer_hash).toBe(
    questionAnswerHash(urs.open_questions[0]),
  );
  expect(acceptedDecisionLedger(urs)[0]).toMatchObject({
    authority: 'legacy',
    basis: 'legacy',
    citations: [],
  });
});

it('keeps explicit decisions distinct from accepted agent recommendations', () => {
  expect(
    acceptedDecisionLedger(
      accepted({
        authority: 'user',
        basis: 'human',
        rationale: 'User edited the boundary.',
        citations: [],
      }),
    )[0],
  ).toMatchObject({ authority: 'user', basis: 'human' });
});

it('preserves URI citation provenance without turning it into normative file inputs', () => {
  const provenance: ResolutionDecision = {
    authority: 'delegated',
    basis: 'documented',
    rationale: 'The selected design page supplies this boundary.',
    citations: [
      { source: 'https://example.test/design', location: 'https://example.test/design#limits' },
    ],
  };
  const urs = accepted(provenance);
  expect(ursSchema.parse(urs)).toEqual(urs);
  expect(acceptedDecisionLedger(urs)[0].citations).toEqual(provenance.citations);
  expect(urs.families[0].requirements[0].references).toEqual([]);
  delete urs.open_questions[0].resolution!.decision;
  const legacy = JSON.stringify(urs);
  expect(JSON.stringify(ursSchema.parse(urs))).toBe(legacy);
  expect(acceptedDecisionLedger(urs)[0].authority).toBe('legacy');
});

it.each([
  (urs: Urs) => {
    urs.open_questions[0].answer = 'Use 2000 instead.';
  },
  (urs: Urs) => {
    urs.open_questions[0].question = 'Which lower boundary should be tested?';
  },
  (urs: Urs) => {
    urs.open_questions[0].requirement = undefined;
  },
  (urs: Urs) => {
    urs.open_questions[0].resolution!.targets = ['requirement:missing'];
  },
  (urs: Urs) => {
    urs.open_questions[0].resolution!.targets.push('requirement:R1');
  },
  (urs: Urs) => {
    urs.open_questions[0].resolution = undefined;
  },
])('excludes stale, unaccepted or invalid decision records (%#)', (mutate) => {
  const urs = accepted();
  mutate(urs);
  expect(acceptedDecisionLedger(urs)).toEqual([]);
});

it('does not promote a legacy delegation instruction without a concrete accepted policy', () => {
  const urs = accepted();
  urs.open_questions[0].answer = 'Choose something reasonable.';
  urs.open_questions[0].resolution!.answer_hash = questionAnswerHash(urs.open_questions[0]);
  expect(acceptedDecisionLedger(urs)).toEqual([]);
});

it('does not accept decision metadata supplied inside a model proposal', () => {
  const urs = accepted();
  urs.open_questions[0].resolution = undefined;
  expect(() =>
    applyResolutionProposal(urs, {
      requirements: [
        {
          question_ids: ['Q1'],
          value: urs.families[0].requirements[0],
          reason: 'Approved.',
          decision,
        },
      ],
      unresolved: [],
    }),
  ).toThrow();
});

it('replacing an accepted answer removes its previous provenance unless a new review supplies it', () => {
  const urs = accepted();
  urs.open_questions[0].answer = 'Test values up to 2000.';
  const next = applyResolutionProposal(urs, {
    requirements: [
      { question_ids: ['Q1'], value: urs.families[0].requirements[0], reason: 'Changed boundary.' },
    ],
    unresolved: [],
  });
  expect(next.open_questions[0].resolution?.decision).toBeUndefined();
  expect(acceptedDecisionLedger(next)[0].authority).toBe('legacy');
});
