#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const args = process.argv.slice(2);
const keep = args.includes('--keep') || process.env.KEEP_PACKAGE_ARTIFACTS === '1';
const positional = args.filter((argument) => argument !== '--keep');
if (positional.length > 1 || positional.some((argument) => argument.startsWith('--')))
  throw new Error('Usage: node scripts/verify-package.mjs [archive.tgz] [--keep]');
let archive = positional[0];
if (!archive) {
  const records = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts'], { encoding: 'utf8' }),
  );
  archive = records[0].filename;
}
archive = resolve(archive);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const archiveSha256 = hash(await readFile(archive));
const workspace = await mkdtemp(join(tmpdir(), 'provenarium package verification '));
const prefix = join(workspace, 'installation prefix');
const globalPrefix = join(workspace, 'global installation prefix');
const project = join(workspace, 'independent validation project');
const runProcess = promisify(execFile);
let server;

function verifyCommandSurface(cli) {
  const run = (...args) =>
    execFileSync(process.execPath, [cli, ...args], {
      cwd: workspace,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  const commands = run('--help').split('Commands:')[1];
  assert.match(commands, /^\s*validate\s/m);
  const legacyCommands = [
    'urs',
    'generate',
    'approve',
    'run',
    'report',
    'context',
    'auth',
    'browser',
    'uninstall',
  ];
  for (const command of legacyCommands) {
    assert.doesNotMatch(commands, new RegExp(`^\\s*${command}\\s`, 'm'));
    assert.throws(() => run(command), /unknown command/i);
  }
  const options = run('validate', '--help');
  assert.match(options, /--context/);
  assert.match(options, /--url/);
  assert.match(options.replace(/\s+/g, ' '), /--provider.*openai.*anthropic/);
  assert.throws(() => run('validate', '--provider', 'unsupported'), /Allowed choices/i);
  for (const flag of [
    '--review-coverage',
    '--yes',
    '--urs',
    '--no-pdf',
    '--rehearse',
    '--plan',
    '--resume',
  ]) {
    assert.ok(!options.includes(flag), `${flag} is still in validate help`);
    assert.throws(() => run('validate', flag), /unknown option/i);
  }
}

try {
  execFileSync('npm', ['install', '--prefix', prefix, archive], { stdio: 'inherit' });
  const requireInstalled = createRequire(join(prefix, 'package.json'));
  const main = requireInstalled.resolve('provenarium-validation');
  const installed = resolve(main, '..', '..');
  const { ursSchema, planSchema, runSchema, createCandidate, loadProject } = await import(
    pathToFileURL(main).href
  );
  const packageInfo = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(packageInfo.name, 'provenarium-validation');
  const dependencyLock = JSON.parse(await readFile(join(installed, 'npm-shrinkwrap.json'), 'utf8'));
  assert.equal(dependencyLock.name, packageInfo.name);
  assert.equal(dependencyLock.version, packageInfo.version);
  assert.deepEqual(dependencyLock.packages[''].dependencies, packageInfo.dependencies);
  const localCli = join(installed, 'bin', 'provenarium.mjs');
  assert.equal(
    execFileSync(process.execPath, [localCli, '--version'], { encoding: 'utf8' }).trim(),
    packageInfo.version,
  );
  verifyCommandSurface(localCli);

  execFileSync('npm', ['install', '--global', '--prefix', globalPrefix, archive], {
    stdio: 'inherit',
  });
  const globalCli = join(globalPrefix, 'bin', 'provenarium');
  const globalPackage = join(globalPrefix, 'lib', 'node_modules', packageInfo.name);
  assert.equal(
    execFileSync(globalCli, ['--version'], { encoding: 'utf8' }).trim(),
    packageInfo.version,
  );
  assert.match(execFileSync(globalCli, ['--help'], { encoding: 'utf8' }), /^\s*validate\s/m);

  let defective = false;
  const saves = [];
  server = createServer((request, response) => {
    if (request.url?.startsWith('/save?')) {
      const id = new URL(request.url, 'http://127.0.0.1').searchParams.get('id');
      saves.push(id);
      response.end(defective ? 'Save failed' : `Saved ${id}`);
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><title>Sample register</title>
      <form><label>Sample ID <input id="sample"></label><button>Save</button><output id="confirmation"></output></form>
      <script>document.forms[0].onsubmit = async (event) => {
        event.preventDefault();
        const id = document.querySelector('#sample').value;
        const response = await fetch('/save?id=' + encodeURIComponent(id));
        document.querySelector('#confirmation').textContent = await response.text();
      };</script>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const statement = 'Saving a Sample ID displays Saved followed by the identifier.';
  const urs = ursSchema.parse({
    schema_version: 1,
    document: {
      id: 'URS-REGISTER',
      revision: '1',
      title: 'Sample register',
      intended_use: 'Record synthetic sample identifiers.',
    },
    families: [
      {
        id: 'records',
        title: 'Records',
        requirements: [{ id: 'URS-SAVE', title: 'Save a sample', statement }],
      },
    ],
  });
  const plan = planSchema.parse({
    schema_version: 1,
    runtime_version: 1,
    id: 'IOQ-REGISTER',
    title: 'Sample register qualification',
    urs_revision: '1',
    target: { url, allowed_origins: [new URL(url).origin] },
    environment: { timeout_ms: 1500 },
    obligations: [
      {
        id: 'OB-SAVE',
        requirement_id: 'URS-SAVE',
        source: 'URS-SAVE/statement',
        statement,
        assertion_ids: ['A-SAVED'],
      },
    ],
    cases: [
      {
        id: 'OQ-SAVE',
        title: 'Confirm a saved sample',
        classification: 'OQ',
        requirements: ['URS-SAVE'],
        steps: [
          {
            id: '01',
            instruction: 'Save the synthetic identifier and check the displayed message.',
            actions: [
              { op: 'navigate', url: '/' },
              { op: 'fill', locator: { by: 'label', value: 'Sample ID' }, value: 'SYNTH-1' },
              { op: 'click', locator: { by: 'role', role: 'button', value: 'Save' } },
            ],
            assertions: [
              {
                id: 'A-SAVED',
                locator: { by: 'css', value: '#confirmation' },
                read: 'text',
                comparison: 'equals',
                expected: 'Saved SYNTH-1',
              },
            ],
          },
        ],
      },
    ],
  });
  const candidate = await createCandidate(project, urs, plan, { pdf: false });
  await writeFile(join(project, 'urs.yaml'), await readFile(join(candidate.directory, 'urs.yaml')));

  // The only mocked interaction is the human authorization of the retained URS.
  // The installed command runs its own dry run, package freeze, browser execution and report.
  const prompts = join(workspace, 'approval-prompt.mjs');
  await writeFile(
    prompts,
    `
import { registerHooks } from 'node:module';
Object.defineProperty(process.stdin, 'isTTY', { value: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true });
globalThis.fetch = () => { throw new Error('A saved IOQ must not dispatch a provider request.'); };
const fixtures = \`export async function confirm({ message }) {
  if (!/approve.*requirements/i.test(message)) throw new Error('Unexpected confirmation: ' + message);
  return true;
}
export function text() { throw new Error('Unexpected text prompt.'); }
export function select() { throw new Error('Unexpected selection prompt.'); }
export function password() { throw new Error('Unexpected password prompt.'); }
export function isCancel(value) { return typeof value === 'symbol'; }\`;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@clack/prompts') return { url: 'data:text/javascript,' + encodeURIComponent(fixtures), shortCircuit: true };
  return nextResolve(specifier, context);
} });
`,
  );
  const validate = () =>
    runProcess(
      process.execPath,
      ['--import', prompts, globalCli, '--project', project, 'validate'],
      { cwd: workspace, encoding: 'utf8' },
    );
  const goodResult = await validate();
  assert.match(goodResult.stdout, /Dry run passed/);
  assert.match(goodResult.stdout, /Result: 1\/1 cases passed/);
  assert.deepEqual(saves, ['SYNTH-1', 'SYNTH-1']);
  const goodProject = await loadProject(project);
  const goodRunPath = join(project, 'runs', goodProject.last_run);
  const goodReport = join(goodRunPath, 'reports', 'executed-record.html');
  assert.match(await readFile(goodReport, 'utf8'), /OQ-SAVE/);
  const good = runSchema.parse(JSON.parse(await readFile(join(goodRunPath, 'run.json'), 'utf8')));
  assert.equal(good.complete, true);
  assert.equal(good.cases[0].status, 'passed');
  assert.equal(goodProject.current_candidate, `candidates/${candidate.id}`);
  const approvalPath = join(project, 'packages', goodProject.current_package, 'approval.json');
  const approvalHash = hash(await readFile(approvalPath));

  defective = true;
  await assert.rejects(validate(), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /OQ-SAVE\s*\/\s*A-SAVED/);
    assert.match(error.stdout, /The IOQ is saved/);
    return true;
  });
  assert.deepEqual(saves, ['SYNTH-1', 'SYNTH-1', 'SYNTH-1']);
  assert.deepEqual(await loadProject(project), goodProject);
  assert.equal(hash(await readFile(approvalPath)), approvalHash);
  assert.equal((await readdir(project)).includes('node_modules'), false);

  execFileSync('npm', ['uninstall', '--global', '--prefix', globalPrefix, packageInfo.name], {
    stdio: 'inherit',
  });
  await assert.rejects(access(globalPackage), { code: 'ENOENT' });
  await assert.rejects(access(globalCli), { code: 'ENOENT' });
  await access(goodReport);
  assert.equal(
    hash(await readFile(archive)),
    archiveSha256,
    'Release archive changed during verification',
  );

  const result = {
    package: `${packageInfo.name}@${packageInfo.version}`,
    archive_sha256: archiveSha256,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    validate: 'passed',
    defective_dry_run: 'detected',
    project_has_node_modules: false,
    global_install_uninstall: 'passed',
    report: goodReport,
  };
  await writeFile(join(workspace, 'verification.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Installed validate workflow passed: ${JSON.stringify(result)}`);
} finally {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (keep) console.log(`Package verification artifacts: ${workspace}`);
  else await rm(workspace, { recursive: true, force: true });
}
