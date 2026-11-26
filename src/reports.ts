import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import {
  type Plan,
  type Urs,
  type Run,
  type Observation,
  runSchema,
  planSchema,
  observationSchema,
  approvalSchema,
} from './schema.js';
import { atomicWrite, exists, readJson, readYaml, safePath, sha256 } from './files.js';
import { loadUrs, questionStatus, requirements } from './urs.js';
import { describeAction, describeAssertion } from './compiler.js';
import { loadProject } from './project.js';

export const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const e = escapeHtml;
function table(headers: string[], rows: unknown[][]): string {
  const widths = headers[0] === 'Step' && headers.length === 4 ? [12, 30, 28, 30] : undefined;
  return `<table>${widths ? `<colgroup>${widths.map((w) => `<col style="width:${w}%">`).join('')}</colgroup>` : ''}<thead><tr>${headers.map((h) => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((v) => `<td>${e(typeof v === 'object' ? JSON.stringify(v) : v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)}</title><style>
  :root{color-scheme:light}*{box-sizing:border-box}body{font:14px/1.5 system-ui,-apple-system,sans-serif;color:#192c36;background:#edf2f3;margin:0}main{max-width:1120px;margin:32px auto;padding:40px;background:white;border-top:7px solid #145e68}h1{font-size:30px;line-height:1.2;margin:12px 0 28px}h2{font-size:21px;margin:32px 0 12px;border-bottom:1px solid #bfd1d4;padding-bottom:8px}h3{margin:24px 0 8px}p,li{overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;table-layout:fixed;margin:14px 0;font-size:12px}th,td{text-align:left;vertical-align:top;border:1px solid #cbd9dc;padding:9px;overflow-wrap:anywhere;white-space:pre-wrap}th{background:#e6f0f0;color:#164d54}thead{display:table-header-group}.eyebrow{letter-spacing:.14em;text-transform:uppercase;font-size:11px;color:#477078}.muted{color:#526771}.warning{border-left:4px solid #bd6421;background:#fff3e8;padding:12px}.passed{color:#17673a}.failed,.blocked{color:#a12220}.manual_pending,.not_run{color:#80531b}.evidence{max-width:100%;max-height:480px;object-fit:contain;border:1px solid #ccd8da}code{overflow-wrap:anywhere}a{color:#006d86}section{margin-top:20px}@page{size:A4;margin:17mm 12mm 20mm}@media print{body{background:white}main{max-width:none;margin:0;padding:0;border-top:4px solid #145e68}h2,h3{break-after:avoid}tr,img{break-inside:avoid}table{font-size:10px}th,td{padding:6px}.evidence{max-height:145mm}a{color:inherit}}
  </style></head><body><main><div class="eyebrow">Provenarium · software validation</div><h1>${e(title)}</h1>${body}<p class="muted">Local records support the organization's review. Customer acceptance and validation conclusions remain separate decisions.</p></main></body></html>`;
}
export function ursHtml(urs: Urs): string {
  return layout(
    urs.document.title || 'Untitled requirements',
    `<p>${e(urs.document.id)} · Revision ${e(urs.document.revision)}</p><h2>Intended use</h2><p>${e(urs.document.intended_use || 'Not yet specified')}</p>${urs.document.description ? `<p>${e(urs.document.description)}</p>` : ''}<p>Roles: ${e(urs.document.roles.join(', ') || 'Not yet specified')}</p>${
      urs.document.interfaces.length
        ? `<h2>Interfaces</h2>${table(
            ['Name', 'Direction', 'Format', 'Transfer', 'Data'],
            urs.document.interfaces.map((i) => [i.name, i.direction, i.format, i.transfer, i.data]),
          )}`
        : ''
    }${urs.families.map((f) => `<h2>${e(f.title)}</h2>${f.requirements.length ? f.requirements.map((r) => `<section><h3>${e(r.id)} — ${e(r.title)}</h3><p>${e(r.statement)}</p>${r.details ? `<ul>${r.details.map((d) => `<li>${e(d)}</li>`).join('')}</ul>` : ''}${r.table ? table(r.table.columns, r.table.rows) : ''}${r.applicable ? '' : `<p class="warning">Not applicable: ${e(r.non_applicability_reason)}</p>`}${r.rationale ? `<p>Rationale: ${e(r.rationale)}</p>` : ''}${r.references.length ? `<p>References: ${e(r.references.join(', '))}</p>` : ''}${r.citations.length ? `<p class="muted">Sources: ${e(r.citations.map((c) => `${c.source}: ${c.location}`).join('; '))}</p>` : ''}</section>`).join('') : '<p class="warning">No requirements have been written.</p>'}`).join('')}<h2>Questions and decisions</h2>${
      urs.open_questions.length
        ? urs.open_questions
            .map((q) => {
              const status = {
                unanswered: 'Unanswered',
                answered: 'Answer recorded; changes pending review',
                resolved: 'Resolved; requirement changes reviewed',
              }[questionStatus(urs, q)];
              return `<section><h3>${e(q.id)}${q.requirement ? ` · ${e(q.requirement)}` : ''}</h3><p><strong>Question:</strong> ${e(q.question)}</p><p style="white-space:pre-wrap"><strong>Answer:</strong> ${e(q.answer || 'Not answered')}</p><p class="muted"><strong>Status:</strong> ${e(status)}</p></section>`;
            })
            .join('')
        : '<p>None recorded.</p>'
    }`,
  );
}
export function protocolHtml(plan: Plan, urs: Urs, identity: string): string {
  const decisions = plan.questions.filter((q) => q.kind !== 'execution_preparation');
  const cases = plan.cases
    .map(
      (c) =>
        `<section><h2>${e(c.id)} — ${e(c.title)}</h2><p>${e(c.classification)} · Requirements: ${e(c.requirements.join(', '))} · Actor: ${e(c.actor || 'signed-out browser')}</p>${c.prerequisites.length ? `<p>Prerequisites: ${e(c.prerequisites.join('; '))}</p>` : ''}${c.citations.length ? `<p class="muted">Supporting sources: ${e(c.citations.map((x) => `${x.source}: ${x.location}`).join('; '))}</p>` : ''}${
          c.manual
            ? `<p class="warning">Manual check planned; execution will remain manual_pending.</p><h3>Procedure</h3><p>${e(c.manual_procedure)}</p><h3>Expected result</h3><p>${e(c.manual_expected)}</p>`
            : table(
                ['Step', 'Procedure', 'Expected results', 'Evidence'],
                c.steps.map((s, i) => [
                  `${i + 1}. ${s.id}`,
                  `${s.instruction}\n${s.actions.map(describeAction).join('\n')}`,
                  s.assertions.map((a) => `${a.id}: ${describeAssertion(a)}`).join('\n') ||
                    'No assertion at this step.',
                  s.evidence
                    .map(
                      (ev) => `${ev.id}: ${ev.kind}${ev.required ? ' (required)' : ' (optional)'}`,
                    )
                    .join('\n') || 'None declared',
                ]),
              )
        }</section>`,
    )
    .join('');
  return layout(
    plan.title,
    `<p>IOQ protocol · Package/candidate <strong>${e(identity)}</strong> · URS ${e(urs.document.id)} revision ${e(urs.document.revision)}</p><h2>Purpose and scope</h2><p>${e(urs.document.intended_use)}</p><h2>Environment</h2>${table(['Target', 'Locale', 'Timezone', 'Viewport', 'Assertion timeout'], [[plan.target.url, plan.environment.locale, plan.environment.timezone, `${plan.environment.viewport.width} × ${plan.environment.viewport.height}`, `${plan.environment.timeout_ms} ms`]])}<p>Allowed origins: ${e(plan.target.allowed_origins.join(', '))}. Fixed Chromium procedures; whole-test retries disabled.</p><h2>Required access</h2><p>Before tests start, the CLI collects every listed account binding. Passwords and tokens are entered privately and are not included in this protocol. Roles and starting states are user declarations until tested.</p>${table(
      ['Actor', 'Role / state', 'Access mode', 'Purpose', 'Cases'],
      plan.access.map((a) => [
        a.id,
        `${a.role} / ${a.state}`,
        a.mode,
        a.purpose,
        a.cases.join(', '),
      ]),
    )}<h2>Fixtures and references</h2>${table(['Kind', 'Package-relative path'], [...plan.fixtures.map((f) => ['Fixture', f]), ...plan.references.map((f) => ['Reference', f])])}<h2>Requirements coverage</h2>${table(
      ['Requirement', 'Clause', 'Source location', 'Obligation', 'Assertions / manual cases'],
      plan.obligations.map((o) => [
        o.requirement_id,
        o.id,
        o.source,
        o.statement,
        [...o.assertion_ids, ...o.manual_case_ids].join(', '),
      ]),
    )}${requirements(urs)
      .filter((r) => !r.applicable)
      .map((r) => `<p>${e(r.id)} excluded: ${e(r.non_applicability_reason)}</p>`)
      .join('')}<h2>Open questions</h2>${
      decisions.length
        ? table(
            ['ID', 'Question'],
            decisions.map((q) => [q.id, q.question]),
          )
        : '<p>None recorded.</p>'
    }${executionPreparationsHtml(plan)}${cases}<h2>Context references</h2>${table(
      ['Source', 'Location', 'SHA-256'],
      plan.context_hashes.map((h) => [h.source, h.location, h.sha256]),
    )}<p class="muted">Context hashes identify material read during authoring; they do not verify alignment with the deployed build.</p>`,
  );
}

function executionPreparationsHtml(plan: Plan): string {
  const preparations = plan.questions.filter((q) => q.kind === 'execution_preparation');
  return preparations.length
    ? `<h2>Preparation for manual checks</h2><p>These setup and evidence needs do not block protocol approval. Affected manual checks remain manual_pending; approval does not establish that this work is complete.</p>${table(
        ['ID', 'Preparation or evidence needed', 'Affected manual cases'],
        preparations.map((q) => [q.id, q.question, (q.case_ids ?? []).join(', ')]),
      )}`
    : '';
}
export async function renderPdf(html: string, file: string): Promise<void> {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    throw new Error(
      'Chromium is unavailable. Run provenarium browser install before rendering PDF documents.',
    );
  }
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent(html, { waitUntil: 'load' });
    await mkdir(path.dirname(file), { recursive: true });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="font-size:8px;width:100%;text-align:center;color:#526771">Provenarium · <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margin: { top: '17mm', bottom: '20mm', left: '12mm', right: '12mm' },
    });
    await atomicWrite(file, pdf);
  } finally {
    await browser.close();
  }
}
export async function renderUrs(urs: Urs, base: string, pdf = true): Promise<void> {
  const html = ursHtml(urs);
  await atomicWrite(`${base}.html`, html);
  if (pdf) await renderPdf(html, `${base}.pdf`);
}
function csvCell(v: unknown) {
  let s = String(v ?? '');
  if (/^[=+@-]/.test(s)) s = "'" + s;
  return `"${s.replaceAll('"', '""')}"`;
}
export async function renderReport(
  root: string,
  options: { runId?: string; packageId?: string; pdf?: boolean } = {},
): Promise<{ directory: string; html: string; pdf?: string; csv: string }> {
  const project = await loadProject(root);
  const runId = options.runId ?? (!options.packageId ? project.last_run : undefined);
  const runDir = runId ? await safePath(root, `runs/${runId}`) : undefined;
  const run = runDir
    ? runSchema.parse(await readJson(await safePath(runDir, 'run.json')))
    : undefined;
  const packageId = options.packageId ?? run?.package_id ?? project.current_package;
  if (!packageId)
    throw new Error(
      'No approved package or run selected. Approve a candidate first, or pass --package.',
    );
  if (run && run.package_id !== packageId)
    throw new Error('Selected run belongs to a different package.');
  const packageDir = await safePath(root, `packages/${packageId}`);
  const approval = approvalSchema.parse(
    await readJson(await safePath(packageDir, 'approval.json')),
  );
  if (approval.package_id !== packageId)
    throw new Error('Approval identity does not match the selected package.');
  const plan = planSchema.parse(await readJson(await safePath(packageDir, 'plan.json')));
  const urs = await loadUrs(await safePath(packageDir, 'urs.yaml'));
  const integrity: string[] = [];
  for (const [relative, hash] of Object.entries(approval.files)) {
    try {
      if (sha256(await readFile(await safePath(packageDir, relative))) !== hash)
        integrity.push(`Changed approved input: ${relative}`);
    } catch {
      integrity.push(`Missing or unsafe approved input: ${relative}`);
    }
  }
  if (run) {
    const known = new Set(plan.cases.map((c) => c.id));
    const counts = new Map<string, number>();
    for (const c of run.cases) counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
    if (run.cases.some((c) => !known.has(c.id)) || [...counts.values()].some((n) => n !== 1)) {
      integrity.push('Retained case inventory contains unknown or duplicate cases.');
      run.complete = false;
    }
    run.cases = plan.cases.map((c) => {
      const found = run.cases.find((result) => result.id === c.id);
      if (found && counts.get(c.id) === 1) return found;
      integrity.push(`Missing or ambiguous case result: ${c.id}`);
      run.complete = false;
      return { id: c.id, status: 'not_run', message: 'No unambiguous retained result.' };
    });
  }
  const observations: Observation[] = [];
  if (runDir) {
    const observationFile = await safePath(runDir, 'observations.jsonl');
    if (await exists(observationFile)) {
      const lines = (await readFile(observationFile, 'utf8')).split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
          const observation = observationSchema.parse(JSON.parse(lines[i]));
          if (observation.run_id !== run!.id || observation.package_id !== packageId)
            throw new Error('Identity mismatch');
          observations.push(observation);
        } catch {
          integrity.push(
            `Unreadable or inconsistent observation at line ${i + 1}; earlier valid records remain available.`,
          );
          run!.complete = false;
        }
      }
    } else {
      integrity.push('Missing observation record.');
      run!.complete = false;
    }
  }
  let evidence = '';
  for (const artifact of run?.artifacts ?? []) {
    try {
      const file = await safePath(runDir!, artifact.path);
      const bytes = await readFile(file);
      if (sha256(bytes) !== artifact.sha256) {
        integrity.push(`Changed evidence: ${artifact.path}`);
        continue;
      }
      evidence += `<section><h3>${e(artifact.case_id)} / ${e(artifact.step_id)} — ${e(artifact.id)}</h3>${artifact.kind === 'screenshot' ? `<img class="evidence" alt="${e(artifact.id)}" src="data:image/png;base64,${bytes.toString('base64')}">` : `<p><a href="../${e(artifact.path)}">${e(artifact.path)}</a></p>`}<p class="muted">SHA-256: ${e(artifact.sha256)}</p></section>`;
    } catch {
      integrity.push(`Missing or unsafe evidence: ${artifact.path}`);
    }
  }
  const assertionCase = new Map(
    plan.cases.flatMap((c) =>
      c.steps.flatMap((s) => s.assertions.map((a) => [a.id, c.id] as const)),
    ),
  );
  const traceRows = requirements(urs).flatMap((req) => {
    const obligations = plan.obligations.filter((o) => o.requirement_id === req.id);
    return obligations.length
      ? obligations.map((o) => {
          const caseIds = [
            ...new Set([
              ...o.assertion_ids.map((a) => assertionCase.get(a)!).filter(Boolean),
              ...o.manual_case_ids,
            ]),
          ];
          return [
            req.id,
            o.id,
            o.statement,
            caseIds.join('; '),
            caseIds
              .map((id) => `${id}: ${run?.cases.find((c) => c.id === id)?.status ?? 'not_run'}`)
              .join('; '),
            observations
              .filter((obs) => caseIds.includes(obs.case_id))
              .flatMap((obs) => obs.artifacts.map((a) => a.path))
              .join('; '),
          ];
        })
      : [
          [
            req.id,
            '',
            req.statement,
            '',
            req.applicable ? 'coverage_gap' : `not_applicable: ${req.non_applicability_reason}`,
            '',
          ],
        ];
  });
  const directory = await safePath(runDir ?? packageDir, 'reports');
  await mkdir(directory, { recursive: true });
  const htmlFile = await safePath(directory, run ? 'executed-record.html' : 'ioq.html');
  let html = protocolHtml(plan, urs, packageId);
  if (run) {
    const counts = Object.fromEntries(
      ['passed', 'failed', 'blocked', 'not_run', 'manual_pending'].map((s) => [
        s,
        run.cases.filter((c) => c.status === s).length,
      ]),
    );
    html = layout(
      `Executed record — ${plan.title}`,
      `<p>Run <strong>${e(run.id)}</strong> · Package ${e(packageId)}</p>${!run.complete ? '<p class="warning">INCOMPLETE RUN — execution did not finish.</p>' : ''}<p>Target: ${e(run.target_url)} · Release label: ${e(run.release_label || 'not supplied')}</p><p>Started: ${e(run.started_at)} · Ended: ${e(run.ended_at || 'not finalized')}</p>${table(['Status', 'Count'], Object.entries(counts))}${table(['Runtime', 'Version'], Object.entries(run.versions))}<h2>Account bindings</h2>${table(
        ['Actor', 'Account', 'Declared role', 'Declared state'],
        Object.entries(run.accounts).map(([id, a]) => [id, a.username, a.role, a.state]),
      )}<h2>Case results</h2>${table(
        ['Case', 'Status', 'Details'],
        run.cases.map((c) => [c.id, c.status, c.message]),
      )}${executionPreparationsHtml(plan)}<h2>Original procedures and expected results</h2>${plan.cases
        .map(
          (c) =>
            `<h3>${e(c.id)} — ${e(c.title)}</h3>${
              c.manual
                ? `<p class="warning">Manual work pending: ${e(c.manual_procedure)}. Expected: ${e(c.manual_expected)}</p>`
                : table(
                    ['Step', 'Action', 'Original expectation', 'Actual observations'],
                    c.steps.map((s) => [
                      s.id,
                      s.actions.map(describeAction).join('\n'),
                      s.assertions.map(describeAssertion).join('\n'),
                      observations
                        .filter((o) => o.case_id === c.id && o.step_id === s.id)
                        .map((o) =>
                          o.artifacts.length
                            ? `Evidence retained: ${o.artifacts.map((a) => a.id).join(', ')}`
                            : `${o.status}: ${JSON.stringify(o.actual ?? o.message ?? 'Step completed.')} ${o.assertion_id ?? ''}`,
                        )
                        .join('\n') || 'not_run: no retained observation for this step.',
                    ]),
                  )
            }`,
        )
        .join(
          '',
        )}<h2>Traceability</h2>${table(['Requirement', 'Clause', 'Obligation', 'Cases', 'Execution', 'Evidence'], traceRows)}<h2>Evidence integrity</h2>${integrity.length ? `<div class="warning">${integrity.map((i) => `<p>${e(i)}</p>`).join('')}Recorded case outcomes are historical; affected evidence is not verified.</div>` : '<p>All referenced package inputs and retained artifacts match their recorded hashes.</p>'}<h2>Retained evidence</h2>${evidence}`,
    );
  } else if (integrity.length)
    html = html.replace(
      '</main>',
      `<div class="warning">${integrity.map(e).join('<br>')}</div></main>`,
    );
  await atomicWrite(htmlFile, html);
  const csv = await safePath(directory, 'traceability.csv');
  await atomicWrite(
    csv,
    [['Requirement', 'Clause', 'Obligation', 'Cases', 'Execution', 'Evidence'], ...traceRows]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n') + '\r\n',
  );
  const pdfFile = options.pdf === false ? undefined : htmlFile.replace(/\.html$/, '.pdf');
  if (pdfFile) await renderPdf(html, pdfFile);
  return { directory, html: htmlFile, pdf: pdfFile, csv };
}
