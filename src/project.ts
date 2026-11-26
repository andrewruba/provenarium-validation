import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { stringify } from 'yaml';
import {
  type Project,
  type Urs,
  type Plan,
  type Approval,
  projectSchema,
  ursSchema,
  planSchema,
  approvalSchema,
} from './schema.js';
import {
  atomicWrite,
  exists,
  listFiles,
  readJson,
  readYaml,
  safePath,
  sha256,
  writeJson,
  writeYaml,
} from './files.js';
import { compilePlan, validatePlan } from './compiler.js';
import { checkUrs } from './urs.js';
import { protocolHtml, renderPdf, ursHtml } from './reports.js';

export async function loadProject(root: string): Promise<Project> {
  const file = await safePath(root, 'provenarium.yaml');
  return projectSchema.parse((await exists(file)) ? await readYaml(file) : {});
}
export async function saveProject(root: string, project: Project): Promise<void> {
  await writeYaml(await safePath(root, 'provenarium.yaml'), projectSchema.parse(project));
}
export async function getPackage(
  root: string,
  id?: string,
): Promise<{ directory: string; approval: Approval; plan: Plan; urs: Urs }> {
  id ??= (await loadProject(root)).current_package;
  if (!id) throw new Error('No approved package selected. Run provenarium approve first.');
  const directory = await safePath(root, `packages/${id}`);
  return {
    directory,
    approval: approvalSchema.parse(await readJson(await safePath(directory, 'approval.json'))),
    plan: planSchema.parse(await readJson(await safePath(directory, 'plan.json'))),
    urs: ursSchema.parse(await readYaml(await safePath(directory, 'urs.yaml'))),
  };
}
function changes(previous: { urs: Urs; plan: Plan } | undefined, urs: Urs, plan: Plan) {
  if (!previous)
    return {
      previous_candidate: null,
      summary: ['Initial candidate; review every requirement clause and test case.'],
      expectations: [],
    };
  const summary: string[] = [];
  function compare(label: string, before: { id: string }[], after: { id: string }[]) {
    const old = new Map(before.map((x) => [x.id, x])),
      next = new Map(after.map((x) => [x.id, x]));
    for (const [id, item] of next) {
      if (!old.has(id)) summary.push(`${label} added: ${id}`);
      else if (JSON.stringify(old.get(id)) !== JSON.stringify(item))
        summary.push(`${label} changed: ${id}`);
    }
    for (const id of old.keys()) if (!next.has(id)) summary.push(`${label} removed: ${id}`);
  }
  compare(
    'Requirement',
    previous.urs.families.flatMap((f) => f.requirements),
    urs.families.flatMap((f) => f.requirements),
  );
  compare('Case', previous.plan.cases, plan.cases);
  compare('Clause', previous.plan.obligations, plan.obligations);
  compare('Protocol question or preparation', previous.plan.questions, plan.questions);
  const previousQuestions = new Map(
    previous.plan.questions.map((question) => [question.id, question]),
  );
  const nextQuestions = new Map(plan.questions.map((question) => [question.id, question]));
  const questionChanges = [
    ...new Set([...previousQuestions.keys(), ...nextQuestions.keys()]),
  ].flatMap((id) => {
    const before = previousQuestions.get(id) ?? null;
    const after = nextQuestions.get(id) ?? null;
    return JSON.stringify(before) === JSON.stringify(after)
      ? []
      : [{ id, previous: before, next: after }];
  });
  const before = new Map(
    previous.plan.cases.flatMap((c) => c.steps.flatMap((s) => s.assertions)).map((a) => [a.id, a]),
  );
  const after = new Map(
    plan.cases.flatMap((c) => c.steps.flatMap((s) => s.assertions)).map((a) => [a.id, a]),
  );
  const expectations = [...new Set([...before.keys(), ...after.keys()])].flatMap((id) => {
    const a = before.get(id),
      b = after.get(id);
    const previous = a
        ? { comparison: a.comparison, expected: a.expected, tolerance: a.tolerance }
        : null,
      next = b ? { comparison: b.comparison, expected: b.expected, tolerance: b.tolerance } : null;
    return JSON.stringify(previous) === JSON.stringify(next) ? [] : [{ id, previous, next }];
  });
  return {
    summary: summary.length ? summary : ['No requirement, clause, or case changes.'],
    expectations,
    question_changes: questionChanges,
  };
}
export async function createCandidate(
  root: string,
  ursInput: Urs,
  planInput: Plan,
  options: { files?: Record<string, string | Buffer>; pdf?: boolean } = {},
): Promise<{ id: string; directory: string }> {
  const urs = ursSchema.parse(ursInput),
    plan = planSchema.parse(planInput);
  const id = `candidate-${randomUUID()}`;
  const current = await loadProject(root);
  let previous: { urs: Urs; plan: Plan } | undefined;
  if (current.current_candidate) {
    const dir = await safePath(root, current.current_candidate);
    previous = {
      urs: ursSchema.parse(await readYaml(await safePath(dir, 'urs.yaml'))),
      plan: planSchema.parse(await readJson(await safePath(dir, 'plan.json'))),
    };
  }
  const relative = `candidates/${id}`,
    directory = await safePath(root, relative);
  const staging = await safePath(root, `.provenarium/staging/${id}`);
  await mkdir(staging, { recursive: true });
  try {
    const declared = [...new Set([...plan.fixtures, ...plan.references])];
    for (const supplied of Object.keys(options.files ?? {}))
      if (!declared.includes(supplied)) throw new Error(`Undeclared candidate input: ${supplied}`);
    const reserved = new Set([
      'urs.yaml',
      'plan.json',
      'ioq.html',
      'ioq.pdf',
      'urs.html',
      'questions.json',
      'context-hashes.json',
      'candidate.json',
      'approval.json',
      'changes.json',
    ]);
    for (const relative of declared) {
      if (reserved.has(relative) || relative.startsWith('tests/') || relative.startsWith('.'))
        throw new Error(`Reserved input path: ${relative}`);
      const destination = await safePath(staging, relative);
      const provided = options.files?.[relative];
      const bytes = provided ?? (await readFile(await safePath(root, relative)));
      await atomicWrite(destination, bytes);
    }
    await atomicWrite(path.join(staging, 'urs.yaml'), stringify(urs));
    await writeJson(path.join(staging, 'plan.json'), plan);
    const compiled = compilePlan(plan);
    for (const [file, content] of Object.entries(compiled))
      await atomicWrite(await safePath(staging, file), content);
    const html = protocolHtml(plan, urs, id);
    await atomicWrite(path.join(staging, 'ioq.html'), html);
    await atomicWrite(path.join(staging, 'urs.html'), ursHtml(urs));
    if (options.pdf !== false) await renderPdf(html, path.join(staging, 'ioq.pdf'));
    await writeJson(path.join(staging, 'questions.json'), {
      questions: plan.questions,
      validation_errors: [...(await checkUrs(urs, staging)), ...validatePlan(plan, urs)],
    });
    await writeJson(path.join(staging, 'context-hashes.json'), plan.context_hashes);
    await writeJson(path.join(staging, 'changes.json'), {
      ...changes(previous, urs, plan),
      previous_candidate: current.current_candidate ?? null,
    });
    const generated: Record<string, string> = {};
    for (const name of ['ioq.html', 'ioq.pdf', 'urs.html', ...Object.keys(compiled)])
      if (await exists(path.join(staging, name)))
        generated[name] = sha256(await readFile(path.join(staging, name)));
    await writeJson(path.join(staging, 'candidate.json'), {
      id,
      created_at: new Date().toISOString(),
      generated,
    });
    await mkdir(path.dirname(directory), { recursive: true });
    await rename(staging, directory);
    const project = await loadProject(root);
    project.current_candidate = relative;
    project.target_url = plan.target.url;
    await saveProject(root, project);
    return { id, directory };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
export async function inspectCandidate(
  root: string,
  candidate?: string,
): Promise<{ directory: string; id: string; urs: Urs; plan: Plan; errors: string[] }> {
  candidate ??= (await loadProject(root)).current_candidate;
  if (!candidate) throw new Error('No candidate selected. Run provenarium generate first.');
  const directory = await safePath(root, candidate);
  const metadata = await readJson<{ id: string; generated: Record<string, string> }>(
    await safePath(directory, 'candidate.json'),
  );
  const urs = ursSchema.parse(await readYaml(await safePath(directory, 'urs.yaml')));
  const plan = planSchema.parse(await readJson(await safePath(directory, 'plan.json')));
  const errors = [...(await checkUrs(urs, directory)), ...validatePlan(plan, urs)];
  const compiled = compilePlan(plan);
  for (const [file, expected] of Object.entries(compiled)) {
    try {
      if ((await readFile(await safePath(directory, file), 'utf8')) !== expected)
        errors.push(`Compiled test differs from plan: ${file}`);
    } catch {
      errors.push(`Missing compiled test: ${file}`);
    }
  }
  if (
    (await readFile(await safePath(directory, 'ioq.html'), 'utf8')) !==
    protocolHtml(plan, urs, metadata.id)
  )
    errors.push('Readable IOQ differs from the current plan. Regenerate the candidate.');
  for (const [file, hash] of Object.entries(metadata.generated)) {
    try {
      if (sha256(await readFile(await safePath(directory, file))) !== hash)
        errors.push(`Generated candidate artifact changed: ${file}`);
    } catch {
      errors.push(`Missing generated artifact: ${file}`);
    }
  }
  for (const ref of [...plan.fixtures, ...plan.references])
    try {
      await readFile(await safePath(directory, ref));
    } catch {
      errors.push(`Missing or unsafe package input: ${ref}`);
    }
  for (const r of urs.families.flatMap((f) => f.requirements))
    for (const ref of r.references)
      if (!/^(https:\/\/|context:)/.test(ref) && !plan.references.includes(ref))
        errors.push(`${r.id}: normative reference ${ref} is not declared in the plan.`);
  for (const ref of urs.families.flatMap((f) => f.requirements.flatMap((r) => r.references)))
    if (/^(https:\/\/|context:)/.test(ref))
      errors.push(
        `Normative reference ${ref} must be copied into a package-relative file before approval.`,
      );
  return { directory, id: metadata.id, urs, plan, errors };
}
export async function approveCandidate(
  root: string,
  options: { candidate?: string; pdf?: boolean } = {},
): Promise<Approval> {
  const candidate = await inspectCandidate(root, options.candidate);
  if (candidate.errors.length)
    throw new Error(`Approval blocked:\n${candidate.errors.map((e) => `- ${e}`).join('\n')}`);
  const packageId = `pkg-${randomUUID()}`;
  const directory = await safePath(root, `packages/${packageId}`);
  const staging = await safePath(root, `.provenarium/staging/${packageId}`);
  await mkdir(staging, { recursive: true });
  try {
    const inputs = [...candidate.plan.fixtures, ...candidate.plan.references];
    for (const relative of new Set(inputs))
      await atomicWrite(
        await safePath(staging, relative),
        await readFile(await safePath(candidate.directory, relative)),
      );
    await atomicWrite(path.join(staging, 'urs.yaml'), stringify(candidate.urs));
    await writeJson(path.join(staging, 'plan.json'), candidate.plan);
    await writeJson(path.join(staging, 'context-hashes.json'), candidate.plan.context_hashes);
    for (const [relative, content] of Object.entries(compilePlan(candidate.plan)))
      await atomicWrite(await safePath(staging, relative), content);
    const html = protocolHtml(candidate.plan, candidate.urs, packageId);
    await atomicWrite(path.join(staging, 'ioq.html'), html);
    await atomicWrite(path.join(staging, 'urs.html'), ursHtml(candidate.urs));
    if (options.pdf !== false) await renderPdf(html, path.join(staging, 'ioq.pdf'));
    const files: Record<string, string> = {};
    for (const relative of await listFiles(staging))
      files[relative] = sha256(await readFile(await safePath(staging, relative)));
    const approval: Approval = {
      schema_version: 1,
      package_id: packageId,
      approved_at: new Date().toISOString(),
      runtime_version: 1,
      files,
      tests: Object.keys(compilePlan(candidate.plan)),
    };
    approvalSchema.parse(approval);
    await writeJson(path.join(staging, 'approval.json'), approval);
    await mkdir(path.dirname(directory), { recursive: true });
    await rename(staging, directory);
    const project = await loadProject(root);
    project.current_package = packageId;
    await saveProject(root, project);
    return approval;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
