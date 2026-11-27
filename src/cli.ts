import { Command, Option } from 'commander';
import { confirm, isCancel, select, text } from '@clack/prompts';
import { readFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { spawn } from 'node:child_process';
import { stringify } from 'yaml';
import { z } from 'zod';
import {
  accessSchema,
  contextSourceSchema,
  planSchema,
  providerSchema,
  thoroughnessSchema,
  type Bindings,
  type Plan,
} from './schema.js';
import { atomicWrite, exists, readJson, safePath, sha256, writeJson, writeNew } from './files.js';
import {
  loadUrs,
  checkUrs,
  checkUrsStructure,
  templateText,
  unresolvedQuestions,
  pendingAnsweredQuestions,
} from './urs.js';
import { prepareUrsInputs, projectCommand } from './urs-setup.js';
import { resolveUrsFile, type ResolveUrsRuntime } from './urs-resolve-cli.js';
import { repairUrsReferences } from './urs-reference-repair.js';
import { extractContext } from './context.js';
import { Discovery, type PageObservation } from './authoring/discovery.js';
import { auditAutomation } from './authoring/automation-policy.js';
import {
  automationCheckpoint,
  findAutomationResume,
  loadAutomationResume,
} from './authoring/automation-resume.js';
import { rehearsePlan } from './authoring/rehearsal.js';
import { redact } from './authoring/security.js';
import { validatePlanStructure } from './compiler.js';
import {
  collectPlanInputCatalog,
  planInputPathError,
  validateGeneratedPlanInputs,
} from './plan-inputs.js';
import {
  loadProject,
  saveProject,
  createCandidate,
  approveCandidate,
  inspectCandidate,
  getPackage,
} from './project.js';
import { renderReport, renderUrs } from './reports.js';
import { executePackage, verifyApprovedPackage } from './runtime/index.js';
import { getProviderKey, forgetProviderKey, prepareBindings } from './credentials.js';
import { uninstall } from './uninstall.js';
import {
  draftUrs,
  reviewUrs,
  proposeUrsResolution,
  suggestUrsAnswers,
  generatePlan,
  DEFAULT_MODELS,
  PRESETS,
  Budget,
  type AuthoringOptions,
  type AuthoringResult,
  type GeneratedPlan,
} from './authoring/index.js';

const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
const packageInfo = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const program = new Command()
  .name('provenarium')
  .description('Local requirements, qualification protocols, and browser test evidence')
  .version(packageInfo.version)
  .option('--project <directory>', 'Validation project directory', '.');
function root(command: Command) {
  return path.resolve(command.optsWithGlobals().project as string);
}
function showExecutionPreparations(plan: Plan) {
  const preparations = plan.questions.filter(
    (question) => question.kind === 'execution_preparation',
  );
  if (preparations.length)
    console.log(
      `Manual test setup — these cases remain manual_pending until their evidence is recorded:\n${preparations.map((question) => `- ${question.id} [${question.case_ids?.join(', ')}]: ${question.question}`).join('\n')}`,
    );
}
function terminal() {
  if (!process.stdin.isTTY)
    throw new Error(
      'This action needs an interactive terminal; supply the documented explicit options instead.',
    );
}
function answer<T>(value: T): Exclude<T, symbol> {
  if (typeof value === 'symbol') throw new Error('Cancelled.');
  return value as Exclude<T, symbol>;
}
function paid(
  command: Command,
  options: { thoroughness?: boolean; yesDescription?: string } = {},
): Command {
  command
    .addOption(
      new Option('--provider <provider>', 'Authoring provider').choices(['openai', 'anthropic']),
    )
    .option('--model <model>', 'Model in the supported pricing catalog');
  if (options.thoroughness !== false)
    command.addOption(
      new Option('--thoroughness <level>', 'Authoring depth and test breadth').choices([
        'quick',
        'standard',
        'thorough',
      ]),
    );
  return command
    .option('--max-spend <USD>', 'Maximum total spend for this command', (value) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--max-spend must be positive.');
      return n;
    })
    .option('--source <ids...>', 'Select linked context source IDs')
    .option(
      '--yes',
      options.yesDescription ?? 'Accept the displayed data-sharing and spending preview',
    );
}
async function authoring(
  command: Command,
  options: {
    resolution?: boolean;
    resolutionSuggestions?: boolean;
    requirementsDraft?: boolean;
    referenceFiles?: string[];
  } = {},
): Promise<AuthoringOptions> {
  const opts = command.opts(),
    directory = root(command),
    project = await loadProject(directory);
  let provider = opts.provider ?? project.provider;
  if (!provider) {
    terminal();
    provider = answer(
      await select({
        message: 'Authoring provider',
        options: [
          { value: 'openai', label: 'OpenAI' },
          { value: 'anthropic', label: 'Anthropic' },
        ],
      }),
    );
  }
  provider = providerSchema.parse(provider);
  let tier = thoroughnessSchema.parse(opts.thoroughness ?? project.thoroughness ?? 'standard');
  if (!options.resolution && !opts.thoroughness && !opts.yes) {
    terminal();
    const capLabel = (level: keyof typeof PRESETS) =>
      `$${(opts.maxSpend ?? PRESETS[level].cap).toFixed(2)} max per command`;
    tier = thoroughnessSchema.parse(
      answer(
        await select({
          message: 'Authoring thoroughness',
          initialValue: tier,
          options: [
            {
              value: 'quick',
              label: `Quick (${capLabel('quick')})`,
              hint: 'Focused draft and review',
            },
            {
              value: 'standard',
              label: `Standard (${capLabel('standard')})`,
              hint: 'Broader review of boundaries, access, and exports',
            },
            {
              value: 'thorough',
              label: `Thorough (${capLabel('thorough')})`,
              hint: 'Extra review of edge cases and failure scenarios',
            },
          ],
        }),
      ),
    );
  }
  const model =
    opts.model ??
    (provider === project.provider ? project.model : undefined) ??
    DEFAULT_MODELS[providerSchema.parse(provider)];
  const cap = opts.maxSpend ?? PRESETS[tier].cap;
  const sources = project.context.filter((s) => !opts.source || opts.source.includes(s.id));
  if (opts.source?.some((id: string) => !project.context.some((s) => s.id === id)))
    throw new Error('Unknown selected context source. Use provenarium context list.');
  console.log(
    options.resolution
      ? `Requirements review: ${provider} / ${model}; recommendations and requirement changes; maximum $${cap.toFixed(2)} USD total for this command.`
      : `Authoring: ${provider} / ${model}; ${tier}; maximum $${cap.toFixed(2)} USD for this command.`,
  );
  console.log(
    'Requirements, selected context excerpts, and sanitized application observations go directly to this provider.',
  );
  console.log(
    sources.length
      ? sources.map((s) => `  ${s.id}: ${s.path ?? s.url}`).join('\n')
      : '  No linked context sources selected.',
  );
  if (sources.some((source) => source.path))
    console.log(
      'Local HTML context includes its source and bounded JavaScript companions within the selected source folder.',
    );
  if (options.requirementsDraft)
    console.log(
      'This ceiling covers requirements drafting and the recommendation review, including edited review updates.',
    );
  if (options.resolutionSuggestions && project.target_url)
    console.log(`  Read-only application observation: ${project.target_url}`);
  if (options.referenceFiles?.length)
    console.log(
      `  Declared requirement reference excerpts:\n${options.referenceFiles.map((file) => `    ${file}`).join('\n')}`,
    );
  if (!opts.yes) {
    terminal();
    if (
      !answer(
        await confirm({
          message: 'Use this provider, selected material, and spending ceiling?',
          initialValue: false,
        }),
      )
    )
      throw new Error('Authoring cancelled before any paid request.');
  }
  const key = await getProviderKey(provider);
  project.provider = provider;
  project.model = model;
  project.thoroughness = tier;
  await saveProject(directory, project);
  return {
    root: directory,
    provider,
    model,
    thoroughness: tier,
    maxSpend: cap,
    key,
    signal: abort.signal,
    sources,
    selectedSources: opts.source,
    onProgress: (message) => console.log(message),
  };
}
async function retainResult<T>(directory: string, result: AuthoringResult<T>): Promise<string> {
  const file = await safePath(directory, `drafts/${randomUUID()}.json`);
  await writeJson(file, result);
  console.log(
    `Authoring record: ${file}\nUsage estimate: $${result.spend.actual.toFixed(4)}; uncertain reservations: $${result.spend.reserved.toFixed(4)}; calls: ${result.spend.calls}.`,
  );
  if (result.questions.length) console.log(result.questions.map((q) => `  ${q}`).join('\n'));
  if (result.diagnostics?.length)
    console.log(
      `Authoring diagnostics: ${result.diagnostics.length} entries with redacted output and correction details retained in the authoring record.`,
    );
  if (result.incomplete) {
    console.log(
      'INCOMPLETE: authoring did not finish. See the retained diagnostics; this output is not ready for approval.',
    );
    process.exitCode = 1;
  }
  return file;
}
async function discoveryBindings(command: Command, url?: string): Promise<Bindings | undefined> {
  const opts = command.opts();
  if (!opts.access) return undefined;
  if (!url) throw new Error('--access requires an application URL.');
  const access = z
    .array(accessSchema)
    .parse(await readJson(path.resolve(root(command), opts.access)));
  console.log(`Discovery access is limited to ${new URL(url).origin}.`);
  return prepareBindings(access, root(command), url);
}
function discovery(command: Command): Command {
  return command
    .option('--access <file>', 'Non-secret access inventory JSON for protected discovery')
    .option('--discovery-actor <id>', 'Select a session binding for application discovery')
    .option(
      '--interactive-discovery',
      'Allow declared browser interactions using synthetic test data',
    );
}

async function sharedRequirementsAuthoring(options: AuthoringOptions): Promise<AuthoringOptions> {
  return {
    ...options,
    budget:
      options.budget ??
      new Budget(options.maxSpend ?? PRESETS[options.thoroughness ?? 'standard'].cap),
    context:
      options.context ??
      (await extractContext(options.root, options.sources ?? [], options.selectedSources, {
        signal: options.signal,
      })),
  };
}

function requirementsReviewRuntime(
  directory: string,
  url: string | undefined,
  getOptions: (suggestions: boolean) => Promise<AuthoringOptions>,
): ResolveUrsRuntime {
  const resolutionRepairs = { used: 0 };
  return {
    suggest: async (document, questionIds) => {
      const result = await suggestUrsAnswers({
        ...(await getOptions(true)),
        urs: document,
        questionIds,
        url,
      });
      await retainResult(directory, result);
      return result;
    },
    propose: async (document, recommendations) => {
      const result = await proposeUrsResolution({
        ...(await getOptions(false)),
        urs: document,
        recommendations,
        resolutionRepairs,
      });
      await retainResult(directory, result);
      return result;
    },
  };
}

const urs = program
  .command('urs')
  .description('Draft requirements from application context and its deployed URL');
urs.action(async () => {
  terminal();
  await generateRequirements({ out: 'urs.yaml', detail: 'detailed', pdf: true }, urs);
});
urs
  .command('template')
  .description('Create a blank requirements file to fill in yourself, without AI')
  .option('--out <file>', 'Output path relative to project', 'urs.yaml')
  .action(async (opts, command) => {
    const file = await safePath(root(command), opts.out);
    await writeNew(file, templateText);
    console.log(
      `Blank requirements: ${file}\nEdit this YAML to describe intended use and requirements.\nThen check it: ${projectCommand(root(command), ['urs', 'check', opts.out])}`,
    );
  });
paid(
  urs
    .command('check')
    .description('Check requirements before generating the protocol and tests')
    .argument('<file>')
    .option(
      '--fix-references',
      'Review and repair generated source-reference formatting without AI',
    )
    .option('--review', 'Ask AI for semantic suggestions; never rewrite the URS'),
).action(async (file, opts, command) => {
  if (opts.fixReferences) {
    if (
      opts.review ||
      opts.provider ||
      opts.model ||
      opts.thoroughness ||
      opts.maxSpend ||
      opts.source
    )
      throw new Error(
        '--fix-references does not use AI and cannot be combined with authoring options.',
      );
    const directory = root(command);
    const project = await loadProject(directory);
    const material = await extractContext(directory, project.context, undefined, {
      signal: abort.signal,
    });
    for (const warning of material.warnings) console.log(warning);
    let observation: PageObservation | undefined;
    if (project.target_url) {
      const browser = new Discovery({
        root: directory,
        url: project.target_url,
        allowInteractions: false,
        signal: abort.signal,
      });
      try {
        observation = await browser.open();
      } catch {
        console.log(
          'Application observation unavailable. Only references supported by the linked context can be repaired.',
        );
      } finally {
        await browser.close();
      }
    }
    await repairUrsReferences({
      root: directory,
      file,
      context: material,
      observation,
      yes: opts.yes,
    });
  }
  const document = await loadUrs(path.resolve(root(command), file));
  const errors = await checkUrs(document, root(command));
  const pendingAnswers = pendingAnsweredQuestions(document).length;
  if (pendingAnswers) {
    console.log(
      `${pendingAnswers} ${pendingAnswers === 1 ? 'answer is' : 'answers are'} saved. Their requirement changes still need review; check does not apply changes.`,
    );
    console.log(
      `Resume requirement review: ${projectCommand(root(command), ['urs', 'resolve', file])}`,
    );
  }
  console.log(
    errors.length ? errors.map((e) => `- ${e}`).join('\n') : 'URS structural checks passed.',
  );
  if (errors.length) process.exitCode = 1;
  if (opts.review) {
    const result = await reviewUrs({ ...(await authoring(command)), urs: document });
    await retainResult(root(command), result);
    if (result.value) console.log(JSON.stringify(result.value, null, 2));
  } else if (
    opts.provider ||
    opts.model ||
    opts.thoroughness ||
    opts.maxSpend ||
    (opts.yes && !opts.fixReferences) ||
    opts.source
  )
    throw new Error('Authoring options require urs check --review.');
  if (!errors.length) {
    const url = (await loadProject(root(command))).target_url;
    console.log(
      `After reviewing the requirements, generate the protocol and tests:\n${projectCommand(root(command), ['generate', '--urs', file, ...(url ? ['--url', url] : [])])}${url ? '' : ' --url <app-url>'}`,
    );
  }
});
paid(
  urs
    .command('resolve')
    .description('Answer URS questions and review their proposed requirement changes')
    .argument('[file]', 'Working requirements YAML file', 'urs.yaml')
    .option('--answers-only', 'Record answers without an AI request or requirement changes')
    .option('--apply <proposal>', 'Review a saved proposal without another AI request')
    .option('--resume <review>', 'Continue retained unapproved edits and prepare a new review')
    .option(
      '--question <id>',
      'Enter or revise a specific answer; repeat to select more',
      (value: string, previous: string[]) => [...previous, value],
      [],
    ),
  {
    thoroughness: false,
    yesDescription: 'Accept the authoring preview; with --apply, accept the saved changes',
  },
).action(async (file, opts, command) => {
  if (
    (opts.answersOnly || opts.apply) &&
    (opts.provider || opts.model || opts.thoroughness || opts.maxSpend || opts.source)
  )
    throw new Error('--answers-only and --apply are offline and do not accept authoring options.');
  const directory = root(command);
  const project = await loadProject(directory);
  let authoringOptions: Promise<AuthoringOptions> | undefined;
  const resolutionOptions = (suggestions: boolean) =>
    (authoringOptions ??= authoring(command, {
      resolution: true,
      resolutionSuggestions: suggestions,
    }).then(sharedRequirementsAuthoring));
  await resolveUrsFile(
    {
      root: directory,
      file,
      answersOnly: opts.answersOnly,
      apply: opts.apply,
      resume: opts.resume,
      url: project.target_url,
      yes: opts.yes,
      questions: opts.question,
    },
    requirementsReviewRuntime(directory, project.target_url, resolutionOptions),
  );
});
urs
  .command('render')
  .description('Create HTML and PDF views of an existing requirements file')
  .argument('<file>')
  .option('--no-pdf', 'Render HTML only')
  .action(async (file, opts, command) => {
    const source = path.resolve(root(command), file);
    const document = await loadUrs(source);
    const base = source.replace(/\.(ya?ml)$/i, '');
    await renderUrs(document, base, opts.pdf);
    console.log(`Rendered ${base}.html${opts.pdf ? ' and PDF' : ''}`);
  });
discovery(
  paid(
    urs
      .command('generate')
      .description('Draft requirements from source material and a deployed application')
      .option(
        '--context <location>',
        'Source folder, document, or HTTPS page; repeat to add more',
        (value: string, previous: string[]) => [...previous, value],
        [],
      )
      .option('--brief <file>', 'Optional written guidance in addition to context and the app')
      .option('--out <file>', 'URS output path relative to project', 'urs.yaml')
      .option('--url <url>', 'Deployed application to inspect; saved for later protocol generation')
      .addOption(
        new Option('--detail <style>', 'Requirements elaboration')
          .choices(['detailed', 'concise'])
          .default('detailed'),
      )
      .option('--no-pdf', 'Render HTML only'),
  ),
).action(generateRequirements);

async function generateRequirements(
  opts: {
    out: string;
    detail: 'detailed' | 'concise';
    pdf: boolean;
    brief?: string;
    context?: string[];
    url?: string;
    interactiveDiscovery?: boolean;
    discoveryActor?: string;
    yes?: boolean;
  },
  command: Command,
) {
  const directory = root(command);
  const brief = opts.brief
    ? await readFile(path.resolve(directory, opts.brief), 'utf8')
    : undefined;
  let file = await safePath(directory, opts.out);
  const existing = (await exists(file)) ? await loadUrs(file) : undefined;
  const { url } = await prepareUrsInputs(directory, {
    locations: opts.context,
    url: opts.url,
    hasBrief: !!brief?.trim(),
    interactive: !!process.stdin.isTTY,
  });
  const bindings = await discoveryBindings(command, url);
  const shared = await sharedRequirementsAuthoring(
    await authoring(command, { requirementsDraft: true }),
  );
  const result = await draftUrs({
    ...shared,
    brief,
    existing,
    detail: opts.detail,
    url,
    bindings,
    allowInteractions: !!opts.interactiveDiscovery,
    discoveryActor: opts.discoveryActor,
  });
  await retainResult(directory, result);
  if (result.value) {
    const structuralErrors = await checkUrsStructure(result.value, directory);
    if (structuralErrors.length) {
      process.exitCode = 1;
      console.log(
        `The generated response failed structural validation and was retained only in the authoring record. No requirements file was published.\n${structuralErrors.map((error) => `- ${error}`).join('\n')}`,
      );
      return;
    }
    if (existing) file = file.replace(/\.ya?ml$/i, '') + `.revision-${randomUUID()}.yaml`;
    await writeNew(file, stringify(result.value));
    console.log(`Requirements draft: ${file}${existing ? ' (original preserved)' : ''}`);
    if (!result.incomplete && unresolvedQuestions(result.value).length) {
      await resolveUrsFile(
        { root: directory, file: path.relative(directory, file), yes: opts.yes, url },
        requirementsReviewRuntime(directory, url, async () => shared),
      );
    } else if (result.incomplete) {
      console.log(
        `The incomplete draft is saved for review: ${projectCommand(directory, ['urs', 'resolve', path.relative(directory, file)])}`,
      );
    } else {
      console.log(
        `${result.value.families.reduce((count, family) => count + family.requirements.length, 0)} requirements drafted from supplied material; no additional decisions are pending.`,
      );
      console.log(
        `Review the draft, then generate the protocol and tests: ${projectCommand(directory, ['generate', '--urs', path.relative(directory, file), ...(url ? ['--url', url] : [])])}`,
      );
    }
    await renderUrs(await loadUrs(file), file.replace(/\.ya?ml$/i, ''), opts.pdf);
  }
}

const context = program
  .command('context')
  .description('Link optional background sources for requirements and protocol authoring');
context
  .command('add')
  .argument('<id>')
  .argument('<location>')
  .option('--description <text>')
  .action(async (id, location, opts, command) => {
    const directory = root(command),
      project = await loadProject(directory);
    if (project.context.some((s) => s.id === id))
      throw new Error('That source ID already exists; remove it explicitly before replacing it.');
    const source = contextSourceSchema.parse({
      id,
      ...(location.startsWith('https://') ? { url: location } : { path: location }),
      description: opts.description,
    });
    project.context.push(source);
    await saveProject(directory, project);
    console.log(
      `Linked ${id}: ${location}. Supported: source/text, structured data, DOCX text/tables, text PDF, HTTPS HTML. Extraction warnings are retained during authoring.`,
    );
  });
context.command('list').action(async (_opts, command) => {
  const project = await loadProject(root(command));
  console.log(
    project.context.length
      ? project.context.map((s) => `${s.id}\t${s.path ?? s.url}\t${s.description ?? ''}`).join('\n')
      : 'No linked context sources.',
  );
});
context
  .command('remove')
  .argument('<id>')
  .action(async (id, _opts, command) => {
    const project = await loadProject(root(command));
    if (!project.context.some((s) => s.id === id)) throw new Error('Unknown context source.');
    project.context = project.context.filter((s) => s.id !== id);
    await saveProject(root(command), project);
    console.log(`Removed link ${id}.`);
  });

discovery(
  paid(
    program
      .command('generate')
      .description('Create an IOQ protocol and tests from reviewed requirements')
      .requiredOption('--urs <file>', 'Reviewed requirements')
      .option('--url <url>', 'Application target')
      .option('--plan <file>', 'Compile an existing reviewed typed plan offline')
      .option(
        '--resume <draft-file>',
        'Package completed conversions from a saved authoring record without AI',
      )
      .option('--feedback <file>', 'Feedback against requirement/case/step IDs')
      .option('--rehearse', 'Rehearse scoped synthetic procedures as authoring diagnostics')
      .option('--review-coverage', 'Request optional AI coverage suggestions for human review')
      .option('--allow-manual', 'Allow explicit URS-grounded manual exceptions in generated tests')
      .option('--no-pdf', 'Render HTML only'),
  ),
).action(async (opts, command) => {
  const directory = root(command),
    document = await loadUrs(path.resolve(directory, opts.urs));
  let plan,
    files: Record<string, string | Buffer> = {};
  if (opts.plan) {
    if (
      opts.provider ||
      opts.model ||
      opts.thoroughness ||
      opts.maxSpend ||
      opts.interactiveDiscovery ||
      opts.access ||
      opts.rehearse ||
      opts.reviewCoverage ||
      opts.resume ||
      opts.allowManual ||
      opts.url ||
      opts.feedback ||
      opts.source ||
      opts.discoveryActor ||
      opts.yes
    )
      throw new Error(
        '--plan is offline and does not accept authoring, target-override, feedback, or rehearsal options.',
      );
    const source = path.resolve(directory, opts.plan);
    plan = planSchema.parse(await readJson(source));
    for (const name of new Set([...plan.fixtures, ...plan.references]))
      files[name] = await readFile(await safePath(path.dirname(source), name));
  } else {
    if (opts.resume && (opts.feedback || opts.reviewCoverage || opts.allowManual))
      throw new Error(
        '--resume packages completed conversions without AI and cannot be combined with --feedback, --review-coverage, or --allow-manual.',
      );
    const structuralErrors = await checkUrsStructure(document, directory);
    const inputCatalog = await collectPlanInputCatalog(directory, document);
    if (structuralErrors.length || inputCatalog.errors.length)
      throw new Error(
        `Requirements or their declared reference files are not ready for protocol generation:\n${[...new Set([...structuralErrors, ...inputCatalog.errors])].join('\n')}`,
      );
    const project = await loadProject(directory),
      url = opts.url ?? project.target_url;
    if (!url) throw new Error('Supply --url for application discovery.');
    const prior = project.current_candidate ? await inspectCandidate(directory) : undefined;
    let existing = prior?.plan;
    const automationOnly =
      !!existing?.cases.some((item) => item.manual) &&
      !opts.allowManual &&
      !opts.feedback &&
      isDeepStrictEqual(document, prior?.urs);
    if (opts.resume && !automationOnly)
      throw new Error(
        '--resume requires the original candidate with manual cases and the same reviewed URS.',
      );
    const normativePaths = new Set([
      ...inputCatalog.references.map((reference) => reference.path),
      ...(prior?.urs.families.flatMap((family) =>
        family.requirements.flatMap((requirement) => requirement.references),
      ) ?? []),
    ]);
    let existingFixtures = prior
      ? await Promise.all(
          [...new Set([...prior.plan.fixtures, ...prior.plan.references])]
            .filter((name) => !normativePaths.has(name))
            .map(async (name) => {
              const guidance =
                'Use a reviewed offline plan with --plan, or retain this input as a declared URS reference before authoring. No provider request was sent.';
              if (
                planInputPathError(name) ||
                !/^fixtures\/[A-Za-z0-9_./-]+\.(csv|tsv|json|txt|md)$/.test(name)
              )
                throw new Error(
                  `Prior package input ${JSON.stringify(name)} is not a supported generated text fixture. ${guidance}`,
                );
              const bytes = await readFile(await safePath(prior.directory, name));
              let content: string;
              try {
                content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
              } catch {
                throw new Error(
                  `Prior package input ${JSON.stringify(name)} is not valid UTF-8 text and cannot be preserved by AI authoring. ${guidance}`,
                );
              }
              return { path: name, content };
            }),
        )
      : undefined;
    let feedback = opts.feedback
      ? await readFile(path.resolve(directory, opts.feedback), 'utf8')
      : undefined;
    if (existing?.cases.some((item) => item.manual) && !opts.allowManual && !feedback) {
      feedback =
        'Automate the existing manual cases using accepted requirements and decisions. Preserve every obligation and expected result; resolve preparation through supported browser automation. Do not introduce new product behavior or external approval tasks.';
      if (!opts.resume)
        console.log('Revising the current candidate to automate its manual checks.');
    } else if (existing && !feedback) {
      terminal();
      feedback = answer(
        await text({
          message: 'Describe the revision using requirement, case, or step IDs',
          validate: (value) =>
            value?.trim() ? undefined : 'Feedback is required to revise an existing candidate.',
        }),
      );
    }
    const baseForResume = prior
      ? { plan: prior.plan, fixtures: existingFixtures ?? [] }
      : undefined;
    const preview = { referenceFiles: inputCatalog.references.map((reference) => reference.path) };
    const authoringOptions = automationOnly ? undefined : await authoring(command, preview);
    if (opts.source?.some((id: string) => !project.context.some((source) => source.id === id)))
      throw new Error('Unknown selected context source. Use provenarium context list.');
    const selectedContext = await extractContext(directory, project.context, opts.source, {
      signal: abort.signal,
    });
    const contextHashes = [...selectedContext.hashes];
    if (inputCatalog.references.length) {
      const used = new Set(selectedContext.passages.map((passage) => passage.source));
      let sequence = 0;
      const refs = inputCatalog.references.map((reference) => {
        let id: string;
        do {
          id = `normative-input-${++sequence}`;
        } while (used.has(id));
        used.add(id);
        return { id, path: reference.path };
      });
      const material = await extractContext(directory, refs, undefined, {
        signal: abort.signal,
        maxCharacters: Math.max(
          0,
          120_000 -
            selectedContext.passages.reduce((total, passage) => total + passage.text.length, 0),
        ),
      });
      contextHashes.push(...material.hashes);
    }
    const resumeOptions =
      automationOnly && baseForResume && prior
        ? {
            root: directory,
            base: baseForResume,
            urs: document,
            previousUrs: prior.urs,
            target: url,
            contextHashes,
            inputsModifiedAt: Math.max(
              (await stat(path.resolve(directory, opts.urs))).mtimeMs,
              (await stat(path.join(prior.directory, 'plan.json'))).mtimeMs,
            ),
          }
        : undefined;
    const resumed =
      resumeOptions &&
      (opts.resume
        ? await loadAutomationResume({
            ...resumeOptions,
            file: path.relative(directory, path.resolve(directory, opts.resume)),
          })
        : await findAutomationResume(resumeOptions));
    const recoverOffline =
      resumed && !opts.reviewCoverage && resumed.value.plan.cases.every((item) => !item.manual);
    if (resumed) {
      existing = resumed.value.plan;
      existingFixtures = resumed.value.fixtures;
      console.log(
        `Resuming ${resumed.converted} completed case conversion(s) from ${resumed.file}. ${recoverOffline ? 'Preparing the candidate without a provider request.' : `${existing.cases.filter((item) => item.manual).length} manual case(s) remain.`}`,
      );
    }
    const result: AuthoringResult<GeneratedPlan> = recoverOffline
      ? {
          value: resumed.value,
          incomplete: false,
          questions: [],
          spend: { actual: 0, reserved: 0, calls: 0, cap: 0 },
          reviewRounds: 0,
        }
      : await generatePlan({
          ...(authoringOptions ?? (await authoring(command, preview))),
          context: selectedContext,
          urs: document,
          url,
          existing,
          existingFixtures,
          existingUrs: prior?.urs,
          feedback,
          bindings: await discoveryBindings(command, url),
          allowInteractions: !!opts.interactiveDiscovery || !!opts.rehearse,
          rehearse: !!opts.rehearse,
          reviewCoverage: !!opts.reviewCoverage,
          allowManual: !!opts.allowManual,
          automationOnly,
          discoveryActor: opts.discoveryActor,
        });
    if (result.value && !result.incomplete) {
      const generatedErrors = [
        ...validatePlanStructure(result.value.plan, document),
        ...auditAutomation(result.value.plan, document, { allowManual: !!opts.allowManual }),
        ...(await validateGeneratedPlanInputs(directory, result.value, inputCatalog)),
      ];
      if (generatedErrors.length) {
        result.incomplete = true;
        result.questions.push(
          'Generated protocol failed technical validation before packaging.',
          ...generatedErrors,
        );
      }
    }
    if (recoverOffline && opts.rehearse && result.value && !result.incomplete) {
      const { plan: recoveredPlan, fixtures } = result.value;
      console.log('Rehearsing the recovered candidate as authoring diagnostics.');
      let bindings: Bindings = {};
      try {
        bindings = await prepareBindings(
          recoveredPlan.access,
          directory,
          recoveredPlan.target.url,
          recoveredPlan,
        );
        result.rehearsal = await rehearsePlan(
          directory,
          recoveredPlan,
          fixtures,
          bindings,
          abort.signal,
        );
      } catch (error) {
        const secrets = Object.values(bindings).flatMap(({ password, token }) =>
          [password, token].filter((value): value is string => Boolean(value)),
        );
        result.rehearsalWarning = redact(
          error instanceof Error ? error.message : 'The browser rehearsal could not finish.',
          secrets,
        );
      }
    }
    const checkpoint =
      automationOnly && baseForResume
        ? automationCheckpoint({
            base: baseForResume,
            urs: document,
            target: url,
            contextHashes,
            prior: resumed?.checkpoint,
            diagnostics: result.diagnostics,
            proposals: result.automationProposals,
          })
        : undefined;
    const authoringRecord = await retainResult(directory, {
      ...result,
      ...(resumed ? { resumed_from: resumed.file } : {}),
      ...(checkpoint ? { generation_resume: checkpoint } : {}),
    });
    if (!result.value) return;
    plan = result.value.plan;
    files = Object.fromEntries(result.value.fixtures.map((f) => [f.path, f.content]));
    if (result.incomplete) {
      console.log(
        'Generation stopped before packaging. The attempted plan and diagnostics are retained in the authoring record; no candidate was published.',
      );
      return;
    }
    if (result.rehearsal) {
      const outcomes = result.rehearsal.cases.map(({ id, status }) => `${id} ${status}`);
      console.log(
        `Rehearsal outcomes (authoring diagnostics):\n${outcomes.map((outcome) => `  ${outcome}`).join('\n')}`,
      );
    }
    if (result.rehearsalWarning) console.log(`Rehearsal warning: ${result.rehearsalWarning}`);
    if (result.coverageReviewWarning)
      console.log(`Advisory coverage review: ${result.coverageReviewWarning}`);
    if (result.coverageReview)
      console.log(
        `Advisory coverage review: ${result.coverageReview.summary}\n${result.coverageReview.findings.map(({ requirement, severity, message }) => `  ${requirement} (${severity}): ${message}`).join('\n')}\nSaved in ${authoringRecord}`,
      );
    for (const ref of plan.references)
      if (files[ref] === undefined) {
        const expected = inputCatalog.references.find((reference) => reference.path === ref);
        let bytes: Buffer;
        try {
          bytes = await readFile(await safePath(directory, ref));
        } catch {
          throw new Error(
            `Declared reference ${ref} is no longer available. No candidate was published; restore the reference and regenerate.`,
          );
        }
        if (!expected || sha256(bytes) !== expected.sha256)
          throw new Error(
            `Declared reference ${ref} changed during generation. No candidate was published; regenerate against the current reference.`,
          );
        files[ref] = bytes;
      }
  }
  const candidate = await createCandidate(directory, document, plan, { files, pdf: opts.pdf });
  const manualCases = plan.cases.filter((item) => item.manual);
  console.log(
    `Execution: ${plan.cases.length - manualCases.length} automated; ${manualCases.length} manual${manualCases.length ? ' (review the listed exceptions before approval)' : ''}.`,
  );
  for (const item of manualCases)
    console.log(`  ${item.id}: ${item.manual_reason?.explanation ?? item.manual_procedure}`);
  console.log(
    `Candidate ${candidate.id}\nReview: ${path.join(candidate.directory, 'ioq.html')}\nChanges: ${path.join(candidate.directory, 'changes.json')}\nAccess: ${plan.access.map((a) => `${a.id} (${a.role}/${a.state})`).join(', ') || 'none'}`,
  );
  const inspected = await inspectCandidate(directory);
  showExecutionPreparations(inspected.plan);
  if (inspected.errors.length)
    console.log(`Approval blockers:\n${inspected.errors.map((e) => `- ${e}`).join('\n')}`);
  else
    console.log(`Review the protocol, then approve it: ${projectCommand(directory, ['approve'])}`);
});
program
  .command('approve')
  .option('--candidate <relative-path>', 'Explicit candidate selection')
  .option('--yes', 'Confirm that the exact displayed candidate and coverage were reviewed')
  .option('--no-pdf', 'Keep approval documents HTML only')
  .action(async (opts, command) => {
    const directory = root(command),
      candidate = await inspectCandidate(directory, opts.candidate);
    console.log(
      `Candidate ${candidate.id}\nProtocol: ${path.join(candidate.directory, 'ioq.html')}\nCases: ${candidate.plan.cases.length}; clause mappings: ${candidate.plan.obligations.length}.`,
    );
    const diff = await readJson<{ summary: string[]; expectations: unknown[] }>(
      await safePath(candidate.directory, 'changes.json'),
    );
    console.log(diff.summary.join('\n'));
    showExecutionPreparations(candidate.plan);
    if (diff.expectations.length)
      console.log(
        `Expected-result changes requiring review:\n${JSON.stringify(diff.expectations, null, 2)}`,
      );
    if (candidate.errors.length)
      throw new Error(`Approval blocked:\n${candidate.errors.join('\n')}`);
    if (!opts.yes) {
      terminal();
      if (
        !answer(
          await confirm({
            message:
              'Approve this exact protocol, expected values, clause coverage, and access inventory for execution?',
            initialValue: false,
          }),
        )
      )
        throw new Error('Approval cancelled.');
    }
    const approval = await approveCandidate(directory, {
      candidate: opts.candidate,
      pdf: opts.pdf,
    });
    console.log(
      `Approved package ${approval.package_id}. Next, run will collect all required application access.`,
    );
  });
program
  .command('run')
  .option('--package <id>', 'Approved package')
  .option('--release-label <label>', 'User-supplied target release label')
  .action(async (opts, command) => {
    const directory = root(command),
      selected = await verifyApprovedPackage(directory, opts.package);
    console.log(`Package ${selected.packageId}; target ${selected.plan.target.url}`);
    const result = await executePackage(directory, selected.packageId, {
      releaseLabel: opts.releaseLabel,
      signal: abort.signal,
    });
    console.log(
      `Run ${result.id}: ${result.cases.map((c) => `${c.id}=${c.status}`).join(', ')}\nRender with provenarium report --run ${result.id}`,
    );
    if (!result.complete || result.cases.some((c) => c.status !== 'passed')) process.exitCode = 1;
  });
program
  .command('report')
  .option('--package <id>', 'Render an unexecuted approved protocol')
  .option('--run <id>', 'Render a selected retained run')
  .option('--no-pdf', 'Render HTML/CSV only')
  .action(async (opts, command) => {
    const report = await renderReport(root(command), {
      packageId: opts.package,
      runId: opts.run,
      pdf: opts.pdf,
    });
    console.log(
      `Report: ${report.html}\nTraceability: ${report.csv}${report.pdf ? `\nPDF: ${report.pdf}` : ''}`,
    );
  });

async function authProvider(command: Command) {
  const p = command.opts().provider ?? (await loadProject(root(command))).provider;
  if (p) return providerSchema.parse(p);
  terminal();
  return providerSchema.parse(
    answer(
      await select({
        message: 'Provider',
        options: [
          { value: 'openai', label: 'OpenAI' },
          { value: 'anthropic', label: 'Anthropic' },
        ],
      }),
    ),
  );
}
const auth = program
  .command('auth')
  .description('Store or remove a provider key through secure OS storage')
  .addOption(new Option('--provider <provider>').choices(['openai', 'anthropic']));
auth.action(async (_opts, command) => {
  const provider = await authProvider(command);
  await getProviderKey(provider, { remember: true });
  console.log(`Credential entry completed for ${provider}.`);
});
auth
  .command('forget')
  .addOption(new Option('--provider <provider>').choices(['openai', 'anthropic']))
  .action(async (_opts, command) => {
    const provider = await authProvider(command);
    await forgetProviderKey(provider);
    console.log(`Removed stored ${provider} credential, if present.`);
  });
program
  .command('uninstall')
  .description('Remove this npm global installation, retaining projects, credentials, and browsers')
  .option('--yes', 'Confirm removal without an interactive prompt')
  .option('--dry-run', 'Inspect the installation without removing it')
  .action(async (opts) => {
    await uninstall({ yes: opts.yes, dryRun: opts.dryRun, signal: abort.signal });
  });
program
  .command('browser')
  .description('Explicit browser setup')
  .command('install')
  .action(async () => {
    const require = createRequire(import.meta.url);
    const executable = require.resolve('@playwright/test/cli');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [executable, 'install', 'chromium'], {
        stdio: 'inherit',
      });
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('Browser installation failed.')),
      );
    });
  });

await program.parseAsync().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : 'Command failed.'}`);
  process.exitCode = abort.signal.aborted ? 130 : 1;
});
