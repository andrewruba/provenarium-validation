import { Command, Option } from 'commander';
import { confirm, isCancel, select, text } from '@clack/prompts';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
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
} from './schema.js';
import { atomicWrite, exists, readJson, safePath, writeJson, writeNew } from './files.js';
import { loadUrs, checkUrs, templateText } from './urs.js';
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
  generatePlan,
  DEFAULT_MODELS,
  PRESETS,
  type AuthoringOptions,
  type AuthoringResult,
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
function paid(command: Command): Command {
  return command
    .addOption(
      new Option('--provider <provider>', 'Authoring provider').choices(['openai', 'anthropic']),
    )
    .option('--model <model>', 'Model in the supported pricing catalog')
    .addOption(
      new Option('--thoroughness <level>', 'Authoring depth and test breadth').choices([
        'quick',
        'standard',
        'thorough',
      ]),
    )
    .option('--max-spend <USD>', 'Maximum total spend for this command', (value) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--max-spend must be positive.');
      return n;
    })
    .option('--source <ids...>', 'Select linked context source IDs')
    .option('--yes', 'Accept the displayed data-sharing and spending preview');
}
async function authoring(command: Command): Promise<AuthoringOptions> {
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
  const tier = thoroughnessSchema.parse(opts.thoroughness ?? project.thoroughness ?? 'standard');
  const model =
    opts.model ??
    (provider === project.provider ? project.model : undefined) ??
    DEFAULT_MODELS[providerSchema.parse(provider)];
  const cap = opts.maxSpend ?? PRESETS[tier].cap;
  const sources = project.context.filter((s) => !opts.source || opts.source.includes(s.id));
  if (opts.source?.some((id: string) => !project.context.some((s) => s.id === id)))
    throw new Error('Unknown selected context source. Use provenarium context list.');
  console.log(
    `Authoring: ${provider} / ${model}; ${tier}; maximum $${cap.toFixed(2)} USD for this command.`,
  );
  console.log(
    'Requirements, selected context excerpts, and sanitized application observations go directly to this provider.',
  );
  console.log(
    sources.length
      ? sources.map((s) => `  ${s.id}: ${s.path ?? s.url}`).join('\n')
      : '  No linked context sources selected.',
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
  if (result.incomplete) {
    console.log('INCOMPLETE: retained completed work; resolve the listed issues before approval.');
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

const urs = program
  .command('urs')
  .description('Write, check, and render human-editable requirements');
urs.action(async () => {
  terminal();
  const route = answer(
    await select({
      message: 'Requirements',
      options: [
        { value: 'template', label: 'Start blank' },
        { value: 'generate', label: 'Generate a draft' },
        { value: 'check', label: 'Check an existing URS' },
      ],
    }),
  );
  const args = ['--project', root(urs), 'urs', route];
  if (route === 'check') {
    const file = answer(await text({ message: 'URS file', initialValue: 'urs.yaml' }));
    args.push(file);
  }
  await program.parseAsync(args, { from: 'user' });
});
urs
  .command('template')
  .option('--out <file>', 'Output path relative to project', 'urs.yaml')
  .action(async (opts, command) => {
    const file = await safePath(root(command), opts.out);
    await writeNew(file, templateText);
    console.log(`Blank URS: ${file}. Fill in intended use and requirements before generation.`);
  });
paid(
  urs
    .command('check')
    .argument('<file>')
    .option('--review', 'Ask AI for semantic suggestions; never rewrite the URS'),
).action(async (file, opts, command) => {
  const document = await loadUrs(path.resolve(root(command), file));
  const errors = await checkUrs(document, root(command));
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
    opts.yes ||
    opts.source
  )
    throw new Error('Authoring options require urs check --review.');
});
urs
  .command('render')
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
      .option('--brief <file>', 'Read an intended-use brief')
      .option('--out <file>', 'URS output path relative to project', 'urs.yaml')
      .option('--url <url>', 'Optional existing application')
      .addOption(
        new Option('--detail <style>', 'Requirements elaboration')
          .choices(['detailed', 'concise'])
          .default('detailed'),
      )
      .option('--no-pdf', 'Render HTML only'),
  ),
).action(async (opts, command) => {
  let brief = opts.brief ? await readFile(path.resolve(root(command), opts.brief), 'utf8') : '';
  if (!brief) {
    terminal();
    for (const question of [
      'What is the application used for, and what decisions do its outputs support?',
      'Who uses it, and what are the main journeys?',
      'What inputs, calculations, outputs, constraints, and exclusions are known?',
    ])
      brief += `${question}\n${answer(await text({ message: question, validate: (value) => (value?.trim() ? undefined : 'Describe known facts; say unknown where needed.') }))}\n`;
  }
  const directory = root(command);
  let file = await safePath(directory, opts.out);
  const existing = (await exists(file)) ? await loadUrs(file) : undefined;
  const bindings = await discoveryBindings(command, opts.url);
  const result = await draftUrs({
    ...(await authoring(command)),
    brief,
    existing,
    detail: opts.detail,
    url: opts.url,
    bindings,
    allowInteractions: !!opts.interactiveDiscovery,
    discoveryActor: opts.discoveryActor,
  });
  await retainResult(directory, result);
  if (result.value) {
    if (existing) file = file.replace(/\.ya?ml$/i, '') + `.revision-${randomUUID()}.yaml`;
    await writeNew(file, stringify(result.value));
    await renderUrs(result.value, file.replace(/\.ya?ml$/i, ''), opts.pdf);
    console.log(`Review draft: ${file}${existing ? ' (original preserved)' : ''}`);
  }
});

const context = program.command('context').description('Manage named read-only authoring sources');
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
      .requiredOption('--urs <file>', 'Reviewed requirements')
      .option('--url <url>', 'Application target')
      .option('--plan <file>', 'Compile an existing reviewed typed plan offline')
      .option('--feedback <file>', 'Feedback against requirement/case/step IDs')
      .option('--rehearse', 'Rehearse scoped synthetic procedures as authoring diagnostics')
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
    const project = await loadProject(directory),
      url = opts.url ?? project.target_url;
    if (!url) throw new Error('Supply --url for application discovery.');
    const bindings = await discoveryBindings(command, url);
    const prior = project.current_candidate ? await inspectCandidate(directory) : undefined;
    const existing = prior?.plan;
    let feedback = opts.feedback
      ? await readFile(path.resolve(directory, opts.feedback), 'utf8')
      : undefined;
    if (existing && !feedback) {
      terminal();
      feedback = answer(
        await text({
          message: 'Describe the revision using requirement, case, or step IDs',
          validate: (value) =>
            value?.trim() ? undefined : 'Feedback is required to revise an existing candidate.',
        }),
      );
    }
    const result = await generatePlan({
      ...(await authoring(command)),
      urs: document,
      url,
      existing,
      existingUrs: prior?.urs,
      feedback,
      bindings,
      allowInteractions: !!opts.interactiveDiscovery || !!opts.rehearse,
      rehearse: !!opts.rehearse,
      discoveryActor: opts.discoveryActor,
    });
    await retainResult(directory, result);
    if (!result.value) return;
    plan = result.value.plan;
    files = Object.fromEntries(result.value.fixtures.map((f) => [f.path, f.content]));
    if (result.incomplete) {
      console.log(
        'The partial plan is retained in the authoring record; it is not an approvable candidate.',
      );
      return;
    }
    for (const ref of plan.references)
      if (files[ref] === undefined) files[ref] = await readFile(await safePath(directory, ref));
  }
  const candidate = await createCandidate(directory, document, plan, { files, pdf: opts.pdf });
  console.log(
    `Candidate ${candidate.id}\nReview: ${path.join(candidate.directory, 'ioq.html')}\nChanges: ${path.join(candidate.directory, 'changes.json')}\nAccess: ${plan.access.map((a) => `${a.id} (${a.role}/${a.state})`).join(', ') || 'none'}`,
  );
  const inspected = await inspectCandidate(directory);
  if (inspected.errors.length)
    console.log(`Approval blockers:\n${inspected.errors.map((e) => `- ${e}`).join('\n')}`);
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
    const executable = require.resolve('playwright/cli');
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
