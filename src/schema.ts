import { z } from 'zod';

const id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)
  .max(100);
const nonempty = z.string().trim().min(1);
export const citationSchema = z.strictObject({ source: nonempty, location: nonempty });
export const questionSchema = z.strictObject({
  id,
  question: nonempty,
  requirement: z.string().optional(),
});
export const ursQuestionSchema = questionSchema.extend({
  answer: z.string().nullable().optional(),
  resolution: z
    .strictObject({
      answer_hash: z.string().regex(/^[a-f0-9]{64}$/),
      applied_at: z.iso.datetime(),
      targets: z
        .array(z.string().regex(/^(document|requirement:[A-Za-z0-9][A-Za-z0-9_.-]*)$/))
        .min(1),
    })
    .optional(),
});
export const requirementSchema = z.strictObject({
  id,
  title: nonempty,
  statement: nonempty,
  table: z
    .strictObject({ columns: z.array(nonempty).min(1), rows: z.array(z.array(z.string())) })
    .optional(),
  details: z.array(nonempty).optional(),
  rationale: z.string().optional(),
  risk: z.string().optional(),
  applicable: z.boolean().default(true),
  non_applicability_reason: z.string().optional(),
  references: z
    .array(z.string())
    .default([])
    .describe(
      'Normative input files relative to the validation project, or explicit HTTPS/context inputs requiring retained package copies. Never source descriptions, Markdown links, or test-case IDs.',
    ),
  citations: z
    .array(citationSchema)
    .default([])
    .describe(
      'Source provenance using supplied source IDs and exact locations. Application observations and mentioned test IDs belong here, not in references.',
    ),
});
export const ursSchema = z.strictObject({
  schema_version: z.literal(1),
  document: z.strictObject({
    id,
    revision: nonempty,
    title: z.string(),
    intended_use: z.string(),
    description: z.string().optional(),
    roles: z.array(nonempty).default([]),
    interfaces: z
      .array(
        z.strictObject({
          name: nonempty,
          direction: z.enum(['in', 'out', 'both']),
          format: nonempty,
          transfer: nonempty,
          data: nonempty,
        }),
      )
      .default([]),
  }),
  families: z.array(
    z.strictObject({ id, title: nonempty, requirements: z.array(requirementSchema) }),
  ),
  open_questions: z.array(ursQuestionSchema).default([]),
});
export type Urs = z.infer<typeof ursSchema>;
export const providerSchema = z.enum(['openai', 'anthropic']);
export const thoroughnessSchema = z.enum(['quick', 'standard', 'thorough']);
export const contextSourceSchema = z
  .strictObject({
    id,
    path: z.string().optional(),
    url: z.url().optional(),
    description: z.string().optional(),
  })
  .refine((s) => Boolean(s.path) !== Boolean(s.url), 'Supply exactly one path or URL');
export type ContextSource = z.infer<typeof contextSourceSchema>;
export const projectSchema = z.strictObject({
  schema_version: z.literal(1).default(1),
  context: z.array(contextSourceSchema).default([]),
  provider: providerSchema.optional(),
  model: z.string().optional(),
  thoroughness: thoroughnessSchema.optional(),
  target_url: z.url().optional(),
  current_candidate: z.string().optional(),
  current_package: id.optional(),
  last_run: id.optional(),
});
export type Project = z.infer<typeof projectSchema>;

export const locatorSchema = z
  .strictObject({
    by: z.enum(['role', 'label', 'text', 'testId', 'css']),
    value: nonempty,
    role: z
      .enum([
        'alert',
        'alertdialog',
        'application',
        'article',
        'banner',
        'blockquote',
        'button',
        'caption',
        'cell',
        'checkbox',
        'code',
        'columnheader',
        'combobox',
        'complementary',
        'contentinfo',
        'definition',
        'deletion',
        'dialog',
        'directory',
        'document',
        'emphasis',
        'feed',
        'figure',
        'form',
        'generic',
        'grid',
        'gridcell',
        'group',
        'heading',
        'img',
        'insertion',
        'link',
        'list',
        'listbox',
        'listitem',
        'log',
        'main',
        'marquee',
        'math',
        'meter',
        'menu',
        'menubar',
        'menuitem',
        'menuitemcheckbox',
        'menuitemradio',
        'navigation',
        'none',
        'note',
        'option',
        'paragraph',
        'presentation',
        'progressbar',
        'radio',
        'radiogroup',
        'region',
        'row',
        'rowgroup',
        'rowheader',
        'scrollbar',
        'search',
        'searchbox',
        'separator',
        'slider',
        'spinbutton',
        'status',
        'strong',
        'subscript',
        'superscript',
        'switch',
        'tab',
        'table',
        'tablist',
        'tabpanel',
        'term',
        'textbox',
        'time',
        'timer',
        'toolbar',
        'tooltip',
        'tree',
        'treegrid',
        'treeitem',
      ])
      .optional(),
    exact: z.boolean().default(true),
  })
  .refine((l) => l.by !== 'role' || Boolean(l.role), 'Role locators require a valid role');
export type LocatorSpec = z.infer<typeof locatorSchema>;
const json: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(json),
    z.record(z.string(), json),
  ]),
);
export const actionSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('navigate'), url: nonempty }),
  z.strictObject({ op: z.literal('session'), actor: id }),
  z.strictObject({ op: z.literal('fill'), locator: locatorSchema, value: z.string() }),
  z.strictObject({ op: z.literal('fillSecret'), locator: locatorSchema, binding: nonempty }),
  z.strictObject({ op: z.literal('select'), locator: locatorSchema, value: z.string() }),
  z.strictObject({ op: z.literal('click'), locator: locatorSchema }),
  z.strictObject({ op: z.literal('upload'), locator: locatorSchema, path: nonempty }),
  z.strictObject({ op: z.literal('download'), locator: locatorSchema, save_as: id }),
  z.strictObject({
    op: z.literal('read'),
    locator: locatorSchema,
    as: id,
    read: z.enum(['text', 'value', 'count', 'table']),
  }),
  z.strictObject({
    op: z.literal('request'),
    url: nonempty,
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    body: json.optional(),
    auth_binding: z.string().optional(),
    as: id,
  }),
]);
export type Action = z.infer<typeof actionSchema>;
export const assertionSchema = z
  .strictObject({
    id,
    locator: locatorSchema.optional(),
    variable: nonempty.optional(),
    read: z
      .enum(['text', 'value', 'count', 'table', 'visible', 'enabled', 'checked'])
      .default('text'),
    comparison: z.enum([
      'equals',
      'contains',
      'not_contains',
      'numeric',
      'matches',
      'present',
      'absent',
    ]),
    expected: json.optional(),
    tolerance: z.number().nonnegative().optional(),
  })
  .refine(
    (a) => Boolean(a.locator) !== Boolean(a.variable),
    'Assertion needs exactly one locator or variable',
  );
export type Assertion = z.infer<typeof assertionSchema>;
export const evidenceSchema = z.strictObject({
  id,
  kind: z.enum(['screenshot', 'observation', 'download']),
  variable: z.string().optional(),
  required: z.boolean().default(true),
});
export const stepSchema = z.strictObject({
  id,
  instruction: nonempty,
  actions: z.array(actionSchema),
  assertions: z.array(assertionSchema),
  evidence: z.array(evidenceSchema).default([]),
});
export const caseSchema = z.strictObject({
  id,
  title: nonempty,
  classification: z.enum(['IQ', 'OQ']),
  requirements: z.array(id).min(1),
  actor: id.optional(),
  prerequisites: z.array(nonempty).default([]),
  manual: z.boolean().default(false),
  manual_procedure: z.string().optional(),
  manual_expected: z.string().optional(),
  steps: z.array(stepSchema),
  citations: z.array(citationSchema).default([]),
});
export type TestCase = z.infer<typeof caseSchema>;
export const accessSchema = z.strictObject({
  id,
  role: nonempty,
  state: z.enum(['active', 'disabled', 'nonexistent', 'signed_out', 'incorrect_password']),
  mode: z.enum(['credentials', 'session', 'anonymous']),
  purpose: nonempty,
  cases: z.array(id),
  organization: z.string().optional(),
  distinct_from: z.array(id).default([]),
});
export type Access = z.infer<typeof accessSchema>;
export const contextHashSchema = z.strictObject({
  source: nonempty,
  location: nonempty,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const planSchema = z.strictObject({
  schema_version: z.literal(1),
  runtime_version: z.literal(1),
  id,
  title: nonempty,
  urs_revision: nonempty,
  target: z.strictObject({ url: z.url(), allowed_origins: z.array(z.url()).min(1) }),
  environment: z.strictObject({
    locale: nonempty.default('en-US'),
    timezone: nonempty.default('UTC'),
    viewport: z
      .strictObject({ width: z.number().int().positive(), height: z.number().int().positive() })
      .default({ width: 1280, height: 800 }),
    timeout_ms: z.number().int().min(100).max(120000).default(10000),
  }),
  access: z.array(accessSchema).default([]),
  obligations: z.array(
    z.strictObject({
      id,
      requirement_id: id,
      source: nonempty,
      statement: nonempty,
      assertion_ids: z.array(id).default([]),
      manual_case_ids: z.array(id).default([]),
    }),
  ),
  cases: z.array(caseSchema).min(1),
  questions: z.array(questionSchema).default([]),
  fixtures: z.array(nonempty).default([]),
  references: z.array(nonempty).default([]),
  context_hashes: z.array(contextHashSchema).default([]),
});
export type Plan = z.infer<typeof planSchema>;
export const approvalSchema = z.strictObject({
  schema_version: z.literal(1),
  package_id: id,
  approved_at: z.iso.datetime(),
  runtime_version: z.literal(1),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  tests: z.array(nonempty),
});
export type Approval = z.infer<typeof approvalSchema>;
export const statusSchema = z.enum(['passed', 'failed', 'blocked', 'not_run', 'manual_pending']);
export type CaseStatus = z.infer<typeof statusSchema>;
export const artifactSchema = z.strictObject({
  id: nonempty,
  path: nonempty,
  sha256: z.string(),
  kind: z.string(),
  case_id: id,
  step_id: id,
});
export type Artifact = z.infer<typeof artifactSchema>;
export const observationSchema = z.strictObject({
  run_id: id,
  package_id: id,
  case_id: id,
  step_id: id,
  assertion_id: id.optional(),
  timestamp: z.iso.datetime(),
  status: statusSchema,
  expected: json.optional(),
  actual: json.optional(),
  message: z.string().optional(),
  artifacts: z.array(artifactSchema).default([]),
});
export type Observation = z.infer<typeof observationSchema>;
export const runSchema = z.strictObject({
  schema_version: z.literal(1),
  id,
  package_id: id,
  started_at: z.iso.datetime(),
  ended_at: z.iso.datetime().optional(),
  complete: z.boolean(),
  target_url: z.url(),
  release_label: z.string().optional(),
  versions: z.record(z.string(), z.string()),
  accounts: z.record(
    z.string(),
    z.strictObject({ username: z.string(), role: z.string(), state: z.string() }),
  ),
  cases: z.array(z.strictObject({ id, status: statusSchema, message: z.string().optional() })),
  artifacts: z.array(artifactSchema).default([]),
});
export type Run = z.infer<typeof runSchema>;
export type Binding = {
  username?: string;
  password?: string;
  token?: string;
  storageState?: string;
};
export type Bindings = Record<string, Binding>;
