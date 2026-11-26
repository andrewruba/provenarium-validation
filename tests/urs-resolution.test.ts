import { expect, it } from 'vitest';
import { questionSchema, ursSchema, type Urs } from '../src/schema.js';
import {
  checkUrs,
  pendingAnsweredQuestions,
  questionAnswerHash,
  questionStatus,
  unresolvedQuestions,
} from '../src/urs.js';
import {
  applyResolutionProposal,
  decodeResolutionAuthoringProposal,
  formatResolutionChanges,
  makeResolutionAuthoringSchema,
  resolutionProposalSchema,
  validateResolutionProposal,
  type UrsResolutionProposal,
  type UrsResolutionAuthoringProposal,
} from '../src/urs-resolution.js';

const timestamp = '2026-11-26T01:00:00.000Z';
function fixture(
  answer: string | null | undefined = 'Download column headings with no data rows.',
) {
  return ursSchema.parse({
    schema_version: 1,
    document: {
      id: 'URS-DEMO',
      revision: 'Draft 0.3',
      title: 'Preparation register',
      intended_use: 'Review synthetic preparation records.',
      description: 'Human-reviewed scope.',
    },
    families: [
      {
        id: 'exports',
        title: 'Export behavior',
        requirements: [
          {
            id: 'URS-CSV',
            title: 'CSV export',
            statement: 'Download saved records as CSV.',
            details: ['The empty-export behavior is unresolved.'],
          },
          {
            id: 'URS-RECORDS',
            title: 'Record integrity',
            statement: 'Keep existing records unchanged when export is requested.',
            risk: 'Lost preparation records.',
          },
        ],
      },
    ],
    open_questions: [
      {
        id: 'Q-CSV',
        requirement: 'URS-CSV',
        question: 'What should exporting an empty register produce?',
        answer,
      },
    ],
  });
}
function proposal(urs: Urs): UrsResolutionProposal {
  return {
    requirements: [
      {
        question_ids: ['Q-CSV'],
        value: {
          ...structuredClone(urs.families[0].requirements[0]),
          details: ['With no saved records, download column headings with no data rows.'],
        },
        reason: 'Apply the supplied decision to empty exports.',
      },
    ],
    unresolved: [],
  };
}

function authoredProposal(urs: Urs): UrsResolutionAuthoringProposal {
  return {
    requirements: proposal(urs).requirements.map(({ value, reason }) => ({ value, reason })),
    questions: {
      'Q-CSV': { status: 'resolved', requirement_ids: ['URS-CSV'], document: false },
    },
  };
}

it('separates a clarified answer from a pending decision sharing its requirement', async () => {
  const urs = fixture();
  urs.open_questions.push({
    id: 'Q-LIMITS',
    requirement: 'URS-CSV',
    question: 'What numeric magnitude limits apply to exported concentrations?',
    answer: 'Use explicit magnitude limits.',
  });
  const authored = authoredProposal(urs);
  authored.questions['Q-LIMITS'] = {
    status: 'clarification',
    reason: 'Which minimum and maximum concentration values should be permitted?',
  };
  const original = structuredClone(urs);
  const converted = decodeResolutionAuthoringProposal(urs, authored);
  expect(converted.requirements[0].question_ids).toEqual(['Q-CSV']);
  expect(converted.unresolved).toEqual([
    { question_id: 'Q-LIMITS', reason: authored.questions['Q-LIMITS'].reason },
  ]);
  const applied = applyResolutionProposal(urs, converted, timestamp);
  expect(applied.open_questions.map((question) => questionStatus(applied, question))).toEqual([
    'resolved',
    'answered',
  ]);
  expect(applied.open_questions[1]).toEqual(urs.open_questions[1]);
  expect(applied.families[0].requirements[0].details).toEqual(
    proposal(urs).requirements[0].value.details,
  );
  expect((await checkUrs(applied)).every((issue) => issue.includes('Q-LIMITS'))).toBe(true);
  expect(urs).toEqual(original);
});

it.each([
  { status: 'resolved', requirement_ids: ['URS-CSV'], document: false, reason: 'Still unknown.' },
  { status: 'clarification', reason: 'Specify the headers.', requirement_ids: ['URS-CSV'] },
  { status: 'resolved', requirement_ids: ['URS-CSV'], document: false, unresolved: true },
  [
    { status: 'resolved', requirement_ids: ['URS-CSV'], document: false },
    { status: 'clarification', reason: 'Still unknown.' },
  ],
])('rejects contradictory question dispositions in the provider schema (%j)', (outcome) => {
  const urs = fixture();
  const authored = authoredProposal(urs);
  expect(
    makeResolutionAuthoringSchema(urs).safeParse({
      ...authored,
      questions: { 'Q-CSV': outcome },
    }).success,
  ).toBe(false);
});

it('requires exactly the pending answered question IDs and forbids legacy parallel dispositions', () => {
  const urs = fixture();
  urs.open_questions.push({ id: 'Q-UNANSWERED', question: 'Who reviews records?', answer: null });
  const schema = makeResolutionAuthoringSchema(urs);
  const authored = authoredProposal(urs);
  expect(schema.safeParse(authored).success).toBe(true);
  expect(schema.safeParse({ ...authored, questions: {} }).success).toBe(false);
  expect(
    schema.safeParse({
      ...authored,
      questions: {
        ...authored.questions,
        'Q-UNANSWERED': { status: 'clarification', reason: 'No answer supplied.' },
      },
    }).success,
  ).toBe(false);
  expect(schema.safeParse({ ...authored, unresolved: [] }).success).toBe(false);
  const resolved = applyResolutionProposal(urs, proposal(urs), timestamp);
  expect(makeResolutionAuthoringSchema(resolved).safeParse(authored).success).toBe(false);
});

it('combines multiple reviewed answers into one requirement replacement without duplicating IDs', () => {
  const urs = fixture();
  urs.open_questions.push({
    id: 'Q-CSV-ORDER',
    question: 'Which CSV column order is required?',
    requirement: 'URS-CSV',
    answer: 'Use the register column order.',
  });
  const authored = authoredProposal(urs);
  authored.questions['Q-CSV-ORDER'] = {
    status: 'resolved',
    requirement_ids: ['URS-CSV'],
    document: false,
  };
  authored.requirements[0].value.details!.push('Use the register column order.');
  const converted = decodeResolutionAuthoringProposal(urs, authored);
  expect(converted.requirements).toHaveLength(1);
  expect(converted.requirements[0].question_ids).toEqual(['Q-CSV', 'Q-CSV-ORDER']);
  expect(converted.unresolved).toEqual([]);
});

it.each([
  [
    'missing replacement',
    (value: UrsResolutionAuthoringProposal) => {
      value.requirements = [];
    },
  ],
  [
    'missing document',
    (value: UrsResolutionAuthoringProposal) => {
      value.questions['Q-CSV'] = { status: 'resolved', requirement_ids: [], document: true };
    },
  ],
  [
    'missing target',
    (value: UrsResolutionAuthoringProposal) => {
      value.questions['Q-CSV'] = { status: 'resolved', requirement_ids: [], document: false };
    },
  ],
  [
    'duplicate target',
    (value: UrsResolutionAuthoringProposal) => {
      value.questions['Q-CSV'] = {
        status: 'resolved',
        requirement_ids: ['URS-CSV', 'URS-CSV'],
        document: false,
      };
    },
  ],
  [
    'unknown target',
    (value: UrsResolutionAuthoringProposal) => {
      value.questions['Q-CSV'] = {
        status: 'resolved',
        requirement_ids: ['MISSING'],
        document: false,
      };
    },
  ],
  [
    'unassociated replacement',
    (value: UrsResolutionAuthoringProposal) => {
      value.questions['Q-CSV'] = { status: 'clarification', reason: 'Missing exact values.' };
    },
  ],
  [
    'duplicate replacement',
    (value: UrsResolutionAuthoringProposal) => {
      value.requirements.push(structuredClone(value.requirements[0]));
    },
  ],
] as const)(
  'rejects an authored resolution with %s before changing any answer',
  (_label, mutate) => {
    const urs = fixture();
    const original = structuredClone(urs);
    const authored = authoredProposal(urs);
    mutate(authored);
    expect(() => decodeResolutionAuthoringProposal(urs, authored)).toThrow();
    expect(urs).toEqual(original);
  },
);

it('preserves linked-requirement validation and explicit document targets', () => {
  const urs = fixture();
  const authored = authoredProposal(urs);
  authored.requirements[0].value = structuredClone(urs.families[0].requirements[1]);
  authored.questions['Q-CSV'] = {
    status: 'resolved',
    requirement_ids: ['URS-RECORDS'],
    document: false,
  };
  expect(() => decodeResolutionAuthoringProposal(urs, authored)).toThrow(
    /linked requirement URS-CSV/,
  );

  delete urs.open_questions[0].requirement;
  const { id: _id, revision: _revision, ...document } = urs.document;
  const scoped = {
    requirements: [],
    document: { value: document, reason: 'Confirm the supplied purpose and scope.' },
    questions: { 'Q-CSV': { status: 'resolved', requirement_ids: [], document: true } },
  };
  expect(decodeResolutionAuthoringProposal(urs, scoped).document?.question_ids).toEqual(['Q-CSV']);
  expect(() =>
    decodeResolutionAuthoringProposal(urs, {
      ...scoped,
      questions: { 'Q-CSV': { status: 'clarification', reason: 'Scope remains unspecified.' } },
    }),
  ).toThrow(/document changes are not addressed/);
});

it('converts all clarification outcomes without creating changes or acceptance records', () => {
  const urs = fixture();
  const converted = decodeResolutionAuthoringProposal(urs, {
    requirements: [],
    questions: { 'Q-CSV': { status: 'clarification', reason: 'Which exact column headings?' } },
  });
  expect(converted).toEqual({
    requirements: [],
    unresolved: [{ question_id: 'Q-CSV', reason: 'Which exact column headings?' }],
  });
  expect(applyResolutionProposal(urs, converted, timestamp)).toEqual(urs);
});

it.each([undefined, null, '', '   '])(
  'keeps legacy and blank answers unresolved (%s)',
  async (answer) => {
    const urs = fixture();
    urs.open_questions[0].answer = answer;
    expect(questionStatus(urs, urs.open_questions[0])).toBe('unanswered');
    expect(pendingAnsweredQuestions(urs)).toEqual([]);
    expect(unresolvedQuestions(urs)).toHaveLength(1);
    expect((await checkUrs(urs)).join('\n')).toContain('provenarium urs resolve');
  },
);

it('accepts adjacent answers only in URS questions and requires review before readiness', async () => {
  const urs = fixture();
  expect(ursSchema.parse(urs).open_questions[0].answer).toBe(urs.open_questions[0].answer);
  expect(() => questionSchema.parse(urs.open_questions[0])).toThrow();
  expect(questionStatus(urs, urs.open_questions[0])).toBe('answered');
  expect(pendingAnsweredQuestions(urs)).toHaveLength(1);
  expect((await checkUrs(urs)).join('\n')).toContain('requirement changes need review');
});

it('applies only reviewed targets, retains question history, and advances the revision', async () => {
  const urs = fixture();
  const original = structuredClone(urs);
  const result = applyResolutionProposal(urs, proposal(urs), timestamp);

  expect(urs).toEqual(original);
  expect(result.open_questions).toHaveLength(1);
  expect(result.open_questions[0]).toMatchObject(original.open_questions[0]);
  expect(result.open_questions[0].resolution).toEqual({
    answer_hash: questionAnswerHash(original.open_questions[0]),
    applied_at: timestamp,
    targets: ['requirement:URS-CSV'],
  });
  expect(result.families[0].requirements[0].details).toEqual([
    'With no saved records, download column headings with no data rows.',
  ]);
  expect(result.families[0].requirements[1]).toEqual(original.families[0].requirements[1]);
  expect(result.document).toEqual({ ...original.document, revision: 'Draft 0.4' });
  expect(questionStatus(result, result.open_questions[0])).toBe('resolved');
  expect(unresolvedQuestions(result)).toEqual([]);
  expect(await checkUrs(result)).toEqual([]);
});

it.each(['answer', 'question', 'requirement'] as const)(
  'requires another review after the %s changes',
  async (field) => {
    const urs = fixture();
    const result = applyResolutionProposal(urs, proposal(urs), timestamp);
    result.open_questions[0][field] =
      field === 'requirement' ? 'URS-RECORDS' : 'A changed human decision or question';
    expect(questionStatus(result, result.open_questions[0])).toBe('answered');
    expect((await checkUrs(result)).join('\n')).toContain('requirement changes need review');
  },
);

it('records an applied decision historically while ignoring surrounding answer whitespace', () => {
  const urs = fixture();
  const result = applyResolutionProposal(urs, proposal(urs), timestamp);
  result.open_questions[0].answer = `  ${result.open_questions[0].answer}\n`;
  result.families[0].requirements[0].title = 'Human-edited CSV heading';
  expect(questionStatus(result, result.open_questions[0])).toBe('resolved');
});

it('rejects resolution markers whose targets are missing or duplicated', async () => {
  const urs = fixture();
  const result = applyResolutionProposal(urs, proposal(urs), timestamp);
  result.open_questions[0].resolution!.targets = ['requirement:MISSING'];
  expect(questionStatus(result, result.open_questions[0])).toBe('answered');
  expect((await checkUrs(result)).join('\n')).toContain('unknown resolution target');
  result.open_questions[0].resolution!.targets = ['requirement:URS-CSV', 'requirement:URS-CSV'];
  expect((await checkUrs(result)).join('\n')).toContain('duplicate resolution targets');
});

it('supports partial clarification without dropping unanswered or previously answered questions', () => {
  const urs = fixture();
  urs.open_questions.push(
    { id: 'Q-RETENTION', question: 'How long are records retained?', answer: 'Unknown so far.' },
    { id: 'Q-ROLE', question: 'Who can clear records?', answer: null },
  );
  const changes = proposal(urs);
  changes.unresolved.push({ question_id: 'Q-RETENTION', reason: 'A retention period is needed.' });
  const result = applyResolutionProposal(urs, changes, timestamp);
  expect(result.open_questions.map((question) => questionStatus(result, question))).toEqual([
    'resolved',
    'answered',
    'unanswered',
  ]);
  expect(result.open_questions.slice(1)).toEqual(urs.open_questions.slice(1));
  expect(formatResolutionChanges(urs, changes)).toContain(
    'Q-RETENTION: A retention period is needed.',
  );
});

it('does not advance the revision when every answer still needs clarification', () => {
  const urs = fixture();
  const unresolved = {
    requirements: [],
    unresolved: [{ question_id: 'Q-CSV', reason: 'Specify the exact headings.' }],
  };
  expect(applyResolutionProposal(urs, unresolved, timestamp)).toEqual(urs);
});

it('allows review of an answer already expressed in the existing requirement', async () => {
  const urs = fixture();
  const changes = proposal(urs);
  changes.requirements[0].value = structuredClone(urs.families[0].requirements[0]);
  const preview = formatResolutionChanges(urs, changes);
  expect(preview).toContain('No text change');
  expect(preview).toContain('Current:');
  expect(preview).toContain(urs.families[0].requirements[0].statement);
  const result = applyResolutionProposal(urs, changes, timestamp);
  expect(await checkUrs(result)).toEqual([]);
  expect(result.document.revision).toBe('Draft 0.4');
});

it('shows complete before and after text with question links and proposed revision', () => {
  const urs = fixture();
  const preview = formatResolutionChanges(urs, proposal(urs));
  expect(preview).toContain('Draft 0.3 → Draft 0.4');
  expect(preview).toContain('URS-CSV — Q-CSV');
  expect(preview).toContain(`Question: ${urs.open_questions[0].question}`);
  expect(preview).toContain(`Answer: ${urs.open_questions[0].answer}`);
  expect(preview).toContain('Before:');
  expect(preview).toContain('The empty-export behavior is unresolved.');
  expect(preview).toContain('After:');
  expect(preview).toContain('With no saved records, download column headings with no data rows.');
});

it('supports scope answers without allowing the model to replace document identity or revision', () => {
  const urs = fixture();
  delete urs.open_questions[0].requirement;
  const { id: _id, revision: _revision, ...document } = urs.document;
  const changes = {
    requirements: [],
    document: {
      question_ids: ['Q-CSV'],
      value: { ...document, intended_use: 'Review exported synthetic records only.' },
      reason: 'Apply the clarified scope.',
    },
    unresolved: [],
  };
  expect(formatResolutionChanges(urs, changes)).toContain('Document purpose and scope');
  const result = applyResolutionProposal(urs, changes, timestamp);
  expect(result.document.id).toBe(urs.document.id);
  expect(result.document.revision).toBe('Draft 0.4');
  expect(result.document.intended_use).toBe(changes.document.value.intended_use);
  expect(result.open_questions[0].resolution?.targets).toEqual(['document']);
  expect(() =>
    resolutionProposalSchema.parse({
      ...changes,
      document: { ...changes.document, value: { ...changes.document.value, id: 'REPLACEMENT' } },
    }),
  ).toThrow();
});

it.each([
  [
    'unknown question',
    (p: UrsResolutionProposal) => {
      p.requirements[0].question_ids = ['MISSING'];
    },
  ],
  [
    'duplicate question',
    (p: UrsResolutionProposal) => {
      p.requirements[0].question_ids.push('Q-CSV');
    },
  ],
  [
    'unknown requirement',
    (p: UrsResolutionProposal) => {
      p.requirements[0].value.id = 'MISSING';
    },
  ],
  [
    'duplicate replacement',
    (p: UrsResolutionProposal) => {
      p.requirements.push(structuredClone(p.requirements[0]));
    },
  ],
  [
    'omitted answer',
    (p: UrsResolutionProposal) => {
      p.requirements = [];
    },
  ],
  [
    'wrong linked requirement',
    (p: UrsResolutionProposal) => {
      p.requirements[0].value.id = 'URS-RECORDS';
    },
  ],
  [
    'resolved and unresolved',
    (p: UrsResolutionProposal) => {
      p.unresolved.push({ question_id: 'Q-CSV', reason: 'Still unknown' });
    },
  ],
] as const)('rejects a proposal containing %s', (_name, change) => {
  const urs = fixture();
  const changes = proposal(urs);
  change(changes);
  expect(() => validateResolutionProposal(urs, changes)).toThrow();
  expect(() => applyResolutionProposal(urs, changes, timestamp)).toThrow();
});

it('refuses to modify unanswered or already resolved questions and duplicate source IDs', () => {
  const urs = fixture();
  const changes = proposal(urs);
  const answered = applyResolutionProposal(urs, changes, timestamp);
  expect(() => validateResolutionProposal(answered, changes)).toThrow(/not an answered question/);
  urs.open_questions[0].answer = null;
  expect(() => validateResolutionProposal(urs, changes)).toThrow(/not an answered question/);
  urs.open_questions[0].answer = 'A known answer';
  urs.open_questions.push(structuredClone(urs.open_questions[0]));
  expect(() => validateResolutionProposal(urs, changes)).toThrow(/duplicate question/);
});

it('advances nonnumeric and padded revisions predictably', () => {
  const urs = fixture();
  urs.document.revision = 'Initial draft';
  expect(applyResolutionProposal(urs, proposal(urs), timestamp).document.revision).toBe(
    'Initial draft.1',
  );
  urs.document.revision = 'Draft 009';
  expect(applyResolutionProposal(urs, proposal(urs), timestamp).document.revision).toBe(
    'Draft 010',
  );
});
