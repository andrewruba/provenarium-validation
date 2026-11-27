import { Command, Option } from 'commander';
import { confirm } from '@clack/prompts';
import { chromium } from '@playwright/test';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { spawn } from 'node:child_process';
import { stringify } from 'yaml';
import { providerSchema, type Bindings, type Plan } from './schema.js';
import { exists, safePath, sha256, writeJson, writeNew } from './files.js';
import { loadUrs, checkUrsStructure, unresolvedQuestions } from './urs.js';
import { prepareUrsInputs } from './urs-setup.js';
import { resolveUrsFile, type ResolveUrsRuntime } from './urs-resolve-cli.js';
import { extractContext } from './context.js';
import { auditAutomation } from './authoring/automation-policy.js';
import { checkPlanInBrowser } from './authoring/rehearsal.js';
import { redact, safeUrl } from './authoring/security.js';
import { validatePlan } from './compiler.js';
import { collectPlanInputCatalog, validateGeneratedPlanInputs } from './plan-inputs.js';
import { loadProject, createCandidate, approveCandidate, inspectCandidate } from './project.js';
import { renderReport, renderUrs } from './reports.js';
import { executePackage } from './runtime/index.js';
import { getProviderKey, prepareBindings } from './credentials.js';
import {
  draftUrs,
  proposeUrsResolution,
  suggestUrsAnswers,
  generatePlan,
  type AuthoringOptions,
  type AuthoringResult,
} from './authoring/index.js';
import { Budget, PRESETS } from './authoring/provider.js';

const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
const packageInfo = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const program = new Command()
  .name('provenarium')
  .description('Review requirements, dry-run browser tests, and execute a software validation')
  .version(packageInfo.version)
  .option('--project <directory>', 'Validation project directory', '.');

function terminal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Run provenarium validate in a terminal to review and approve requirements.');
}

function answer<T>(value: T): Exclude<T, symbol> {
  if (typeof value === 'symbol') throw new Error('Cancelled.');
  return value as Exclude<T, symbol>;
}

async function ensureBrowser() {
  try {
    await access(chromium.executablePath());
    return;
  } catch {
    abort.signal.throwIfAborted();
  }
  console.log('Installing Chromium for the browser tests.');
  const playwright = createRequire(import.meta.url).resolve('@playwright/test/cli');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [playwright, 'install', 'chromium'], {
      stdio: 'inherit',
      signal: abort.signal,
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error('Chromium installation failed. Run validate again to retry.')),
    );
  });
}

async function authoring(
  directory: string,
  providerOverride?: AuthoringOptions['provider'],
): Promise<AuthoringOptions> {
  const project = await loadProject(directory);
  const provider = providerOverride ?? project.provider ?? 'openai';
  const cap = PRESETS.standard.cap;
  console.log(`AI authoring with ${provider}, up to $${cap.toFixed(2)} for this validation.`);
  console.log(
    'Requirements, linked source excerpts, and app observations are sent to the provider.',
  );
  for (const source of project.context) console.log(`  ${source.path ?? source.url}`);
  terminal();
  if (!answer(await confirm({ message: 'Start AI authoring?', initialValue: false })))
    throw new Error('Authoring cancelled.');
  const key = await getProviderKey(provider);
  return {
    root: directory,
    provider,
    key,
    budget: new Budget(cap),
    signal: abort.signal,
    context: await extractContext(directory, project.context, undefined, { signal: abort.signal }),
    onProgress: console.log,
  };
}

async function retainResult<T>(directory: string, result: AuthoringResult<T>): Promise<string> {
  const file = await safePath(directory, `drafts/${randomUUID()}.json`);
  await writeJson(file, result);
  console.log(`Authoring record: ${file} (estimated $${result.spend.actual.toFixed(4)})`);
  if (result.questions.length) console.log(result.questions.join('\n'));
  if (result.incomplete) process.exitCode = 1;
  return file;
}

function requirementsReviewRuntime(
  directory: string,
  url: string,
  getOptions: () => Promise<AuthoringOptions>,
): ResolveUrsRuntime {
  const resolutionRepairs = { used: 0 };
  return {
    suggest: async (document, questionIds) => {
      const result = await suggestUrsAnswers({
        ...(await getOptions()),
        urs: document,
        questionIds,
        url,
      });
      await retainResult(directory, result);
      return result;
    },
    propose: async (document, recommendations) => {
      const result = await proposeUrsResolution({
        ...(await getOptions()),
        urs: document,
        recommendations,
        resolutionRepairs,
      });
      await retainResult(directory, result);
      return result;
    },
  };
}

program
  .command('validate')
  .description('Draft, review, dry-run, and execute a validation')
  .option('--url <url>', 'Deployed application URL')
  .addOption(
    new Option('--provider <provider>', 'AI provider for this run').choices(providerSchema.options),
  )
  .option(
    '--context <location>',
    'Source folder or design document (repeatable)',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .action(async (opts, command) => {
    const directory = path.resolve(command.optsWithGlobals().project);
    const file = await safePath(directory, 'urs.yaml');
    const project = await loadProject(directory);
    const { url } = await prepareUrsInputs(directory, {
      locations: opts.context,
      url: opts.url,
      interactive: !!process.stdin.isTTY && !project.target_url,
    });
    if (!url) throw new Error('Supply the deployed application URL with --url.');
    const target = safeUrl(url).href;
    let shared: Promise<AuthoringOptions> | undefined;
    const getAuthoring = () => (shared ??= authoring(directory, opts.provider));
    let document;
    if (await exists(file)) {
      document = await loadUrs(file);
    } else {
      await ensureBrowser();
      console.log('Drafting requirements.');
      const draft = await draftUrs({
        ...(await getAuthoring()),
        url: target,
      });
      await retainResult(directory, draft);
      if (!draft.value || draft.incomplete) return;
      await writeNew(file, stringify(draft.value));
      document = draft.value;
    }
    if (unresolvedQuestions(document).length) {
      await resolveUrsFile(
        { root: directory, file: 'urs.yaml' },
        requirementsReviewRuntime(directory, target, getAuthoring),
      );
      document = await loadUrs(file);
      if (unresolvedQuestions(document).length) {
        console.log('Requirements review is saved. Run validate again to continue.');
        return;
      }
    }
    const catalog = await collectPlanInputCatalog(directory, document);
    const ursIssues = [
      ...new Set([...(await checkUrsStructure(document, directory)), ...catalog.errors]),
    ];
    if (ursIssues.length) throw new Error(ursIssues.join('\n'));
    const ursView = file.replace(/\.ya?ml$/i, '');
    await renderUrs(document, ursView, false);
    console.log(`Review the requirements at ${ursView}.html`);
    terminal();
    if (
      !answer(
        await confirm({
          message: `Approve these requirements and authorize synthetic browser tests at ${target}?`,
          initialValue: false,
        }),
      )
    ) {
      console.log('Requirements saved. Run validate again when you are ready to approve them.');
      return;
    }
    const approvedAt = new Date().toISOString();
    await ensureBrowser();
    const current = await loadProject(directory);
    const prior = current.current_candidate
      ? await inspectCandidate(directory, current.current_candidate)
      : undefined;
    let savedFiles: Record<string, string | Buffer> | undefined;
    if (
      prior &&
      !prior.errors.length &&
      isDeepStrictEqual(prior.urs, document) &&
      prior.plan.target.url === target &&
      prior.plan.target.allowed_origins.every((origin) => origin === new URL(target).origin) &&
      prior.plan.cases.every((item) => !item.manual) &&
      isDeepStrictEqual(current.context, project.context)
    ) {
      const saved = Object.fromEntries(
        await Promise.all(
          [...new Set([...prior.plan.fixtures, ...prior.plan.references])].map(async (relative) => [
            relative,
            await readFile(await safePath(prior.directory, relative)),
          ]),
        ),
      );
      if (
        catalog.references.every((ref) => saved[ref.path] && sha256(saved[ref.path]) === ref.sha256)
      )
        savedFiles = saved;
    }
    let plan: Plan;
    let files: Record<string, string | Buffer>;
    if (savedFiles && prior) {
      plan = prior.plan;
      files = savedFiles;
      console.log('Using the saved IOQ and tests.');
    } else {
      console.log('Preparing the IOQ and Playwright tests.');
      const result = await generatePlan({
        ...(await getAuthoring()),
        urs: document,
        url: target,
      });
      await retainResult(directory, result);
      if (!result.value || result.incomplete) return;
      plan = result.value.plan;
      const inputIssues = await validateGeneratedPlanInputs(directory, result.value, catalog);
      if (inputIssues.length) throw new Error(inputIssues.join('\n'));
      files = Object.fromEntries(result.value.fixtures.map(({ path, content }) => [path, content]));
      for (const ref of catalog.references) {
        const bytes = await readFile(await safePath(directory, ref.path));
        if (sha256(bytes) !== ref.sha256)
          throw new Error(`Requirement reference changed during preparation: ${ref.path}`);
        files[ref.path] = bytes;
      }
    }
    const blockers = [...validatePlan(plan, document), ...auditAutomation(plan, document)];
    if (blockers.length) {
      const candidate = await createCandidate(directory, document, plan, { files, pdf: false });
      throw new Error(
        `Review the IOQ at ${path.join(candidate.directory, 'ioq.html')}\n${blockers.join('\n')}`,
      );
    }
    console.log(`Dry-running ${plan.cases.length} browser tests.`);
    const inputs = Object.entries(files).map(([path, content]) => ({ path, content }));
    let bindings: Bindings = {};
    let dryRun;
    let rehearsalWarning: string | undefined;
    try {
      bindings = await prepareBindings(plan.access, directory, target, plan);
      dryRun = await checkPlanInBrowser(
        directory,
        plan,
        inputs,
        bindings,
        abort.signal,
        console.log,
      );
      rehearsalWarning = dryRun.rehearsalWarning;
    } catch (error) {
      const secrets = Object.values(bindings).flatMap(({ password, token }) =>
        [password, token].filter((item): item is string => !!item),
      );
      rehearsalWarning = redact(
        error instanceof Error ? error.message : 'The browser could not finish.',
        secrets,
      );
    }
    const finalPlan = dryRun?.plan ?? plan;
    const candidate =
      savedFiles && prior && isDeepStrictEqual(finalPlan, prior.plan)
        ? prior
        : await createCandidate(directory, document, finalPlan, { files, pdf: false });
    const diagnostics = await safePath(directory, `drafts/${randomUUID()}.dry-run.json`);
    await writeJson(diagnostics, {
      candidate: candidate.id,
      rehearsal: dryRun?.rehearsal,
      before_repair: dryRun?.rehearsalBeforeRepair,
      warning: rehearsalWarning,
    });
    console.log(
      `IOQ: ${path.join(candidate.directory, 'ioq.html')}\nPlaywright tests: ${path.join(candidate.directory, 'tests')}\nDry run: ${diagnostics}`,
    );
    const failed = dryRun?.rehearsal.cases.filter((item) => item.status !== 'passed') ?? [];
    if (!dryRun || rehearsalWarning || failed.length) {
      if (rehearsalWarning) console.log(`Dry run stopped: ${rehearsalWarning}`);
      for (const item of failed) {
        const action = dryRun?.rehearsal.action_issues?.find((issue) => issue.case_id === item.id);
        const check = dryRun?.rehearsal.observations.find(
          (entry) => entry.case_id === item.id && entry.status !== 'passed',
        );
        if (action) {
          console.log(
            `  ${item.id} / ${action.step_id}: ${action.operation} action ${action.action_index + 1} (${action.reason.replaceAll('_', ' ')}).`,
          );
          continue;
        }
        console.log(
          `  ${item.id}${check ? ` / ${check.assertion_id ?? check.step_id}` : ''}: ${check?.message ?? item.status}`,
        );
      }
      console.log('The IOQ is saved. Run validate again after addressing the dry run results.');
      process.exitCode = 1;
      return;
    }
    const execution = await approveCandidate(directory, {
      candidate: path.relative(directory, candidate.directory),
      pdf: false,
      requirementsApproval: {
        approved_at: approvedAt,
        urs_sha256: sha256(JSON.stringify(document)),
        target_url: target,
        rehearsal_plan_sha256: dryRun.rehearsal.plan_sha256,
        rehearsal_input_hashes: Object.fromEntries(
          inputs.map(({ path, content }) => [path, sha256(content)]),
        ),
      },
    });
    console.log('Dry run passed. Executing the checked tests.');
    const run = await executePackage(directory, execution.package_id, {
      bindings,
      signal: abort.signal,
    });
    const report = await renderReport(directory, { runId: run.id, pdf: false });
    const passed = run.cases.filter((item) => item.status === 'passed').length;
    console.log(
      `Result: ${passed}/${run.cases.length} cases passed.${run.complete ? '' : ' Execution stopped early.'}\nReport: ${report.html}`,
    );
    if (!run.complete || passed !== run.cases.length) process.exitCode = 1;
  });

await program.parseAsync().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : 'Command failed.'}`);
  process.exitCode = abort.signal.aborted ? 130 : 1;
});
