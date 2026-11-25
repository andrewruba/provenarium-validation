import { readFile } from 'node:fs/promises';
import { ursSchema, type Urs } from './schema.js';
import { exists, readYaml, safePath } from './files.js';

export const blankUrs: Urs = ursSchema.parse({
  schema_version: 1,
  document: {
    id: 'URS-NEW',
    revision: '1',
    title: '',
    intended_use: '',
    roles: [],
    interfaces: [],
  },
  families: [{ id: 'workflow', title: 'Main workflow', requirements: [] }],
  open_questions: [],
});
export const templateText = `# Describe intended use, actors, inputs, limits, outputs, and independent expected values.\n# Keep stable IDs. Unknown acceptance limits belong in open_questions.\n# Add requirements under each family: id, title, statement, optional table/details/references.\nschema_version: 1\ndocument:\n  id: URS-NEW\n  revision: '1'\n  title: ''\n  intended_use: ''\n  roles: []\n  interfaces: []\nfamilies:\n  - id: workflow\n    title: Main workflow\n    requirements: []\nopen_questions: []\n`;
export async function loadUrs(file: string): Promise<Urs> {
  return ursSchema.parse(await readYaml(file));
}
export function requirements(urs: Urs) {
  return urs.families.flatMap((f) => f.requirements);
}
export async function checkUrs(urs: Urs, root?: string): Promise<string[]> {
  const errors: string[] = [];
  const ids = new Set<string>();
  if (!urs.document.title.trim()) errors.push('Document title is empty.');
  if (!urs.document.intended_use.trim()) errors.push('Intended use is empty.');
  if (!requirements(urs).length)
    errors.push('No requirements: this template is not ready for protocol generation.');
  for (const family of urs.families) {
    if (ids.has(family.id)) errors.push(`Duplicate ID: ${family.id}`);
    ids.add(family.id);
    for (const req of family.requirements) {
      if (ids.has(req.id)) errors.push(`Duplicate ID: ${req.id}`);
      ids.add(req.id);
      if (!req.applicable && !req.non_applicability_reason?.trim())
        errors.push(`${req.id}: non-applicability needs a rationale.`);
      if (
        /\b(TODO|TBD|FIXME)\b|<placeholder>/i.test(
          [req.statement, ...(req.details ?? []), ...(req.table?.rows.flat() ?? [])].join(' '),
        )
      )
        errors.push(`${req.id}: unresolved placeholder.`);
      if (req.table?.rows.some((r) => r.length !== req.table!.columns.length))
        errors.push(`${req.id}: table row width differs from headers.`);
      for (const reference of req.references)
        if (root && !/^(https:\/\/|context:)/.test(reference)) {
          try {
            const target = await safePath(root, reference);
            if (!(await exists(target))) errors.push(`${req.id}: missing reference ${reference}`);
            else await readFile(target);
          } catch {
            errors.push(`${req.id}: unsafe or unreadable reference ${reference}`);
          }
        }
    }
  }
  for (const question of urs.open_questions) {
    if (ids.has(question.id)) errors.push(`Duplicate ID: ${question.id}`);
    ids.add(question.id);
    if (question.requirement && !requirements(urs).some((r) => r.id === question.requirement))
      errors.push(`${question.id}: unknown requirement ${question.requirement}`);
    errors.push(`${question.id}: ${question.question}`);
  }
  return errors;
}
