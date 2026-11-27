import { rehearsePlan } from '../src/authoring/rehearsal.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planSchema, ursSchema } from '../src/schema.js';
import { applyResolutionProposal } from '../src/urs-resolution.js';
import { acceptedDecisionLedger } from '../src/decisions.js';
import { extractContext } from '../src/context.js';
import { generatePlan } from '../src/authoring/index.js';
import { createCandidate, approveCandidate } from '../src/project.js';
import { executePackage } from '../src/runtime/index.js';
import { renderReport } from '../src/reports.js';
import { providerOutputText } from './provider-fixture.js';

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('delegated decisions through automated qualification', () => {
  it('accepts a sourced default, removes manual setup, rehearses final coverage, approves, runs and reports without hiding defects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provenarium-delegated-workflow-'));
    directories.push(root);
    const script = `function refresh(){document.querySelector('#records').textContent=localStorage.getItem('records')?'Saved record':'No records';}
refresh();
document.querySelector('#save').onclick=()=>{localStorage.setItem('records',JSON.stringify([{name:'Saved record'}]));refresh();};
document.querySelector('#export').onclick=()=>{if(!localStorage.getItem('records')&&!window.defective)return;const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['name\\r\\n']));a.download='records.csv';a.click();};`;
    let defective = false;
    const server = createServer((request, response) => {
      if (request.url === '/app.js') {
        response.setHeader('content-type', 'text/javascript');
        response.end(script);
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(
        `<!doctype html><html><head><title>Records</title></head><body><p id="records"></p><button id="save">Save record</button><button id="export">Export CSV</button><script>window.defective=${defective};</script><script src="/app.js"></script></body></html>`,
      );
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No application address.');
    const url = `http://127.0.0.1:${address.port}`;
    const source = join(root, 'app.js');
    await writeFile(source, script);
    const context = await extractContext(root, [{ id: 'app-source', path: source }]);
    const unanswered = ursSchema.parse({
      schema_version: 1,
      document: {
        id: 'URS',
        revision: '1',
        title: 'Record qualification',
        intended_use: 'Retain and export records in a public browser application.',
      },
      families: [
        {
          id: 'records',
          title: 'Records',
          requirements: [
            {
              id: 'R-SAVE',
              title: 'Persistence',
              statement: 'Saved records shall remain available to the user.',
            },
            {
              id: 'R-EMPTY',
              title: 'Empty export',
              statement:
                'Exporting an empty record set shall produce no download and leave the record set empty.',
            },
          ],
        },
      ],
      open_questions: [
        {
          id: 'Q-SCOPE',
          requirement: 'R-SAVE',
          question: 'Which browser persistence scope is required?',
          answer:
            'Retain saved records across a browser process restart within the same local profile; other profiles remain isolated.',
        },
      ],
    });
    const urs = applyResolutionProposal(
      unanswered,
      {
        requirements: [
          {
            question_ids: ['Q-SCOPE'],
            value: {
              ...unanswered.families[0].requirements[0],
              statement:
                'Saved records shall remain available after a browser process restart within the same local profile; other profiles remain isolated.',
            },
            reason: 'Apply the accepted browser-local persistence default.',
          },
        ],
        unresolved: [],
      },
      new Date().toISOString(),
      new Map([
        [
          'Q-SCOPE',
          {
            authority: 'delegated',
            basis: 'implementation',
            rationale:
              'Source uses browser-local storage; use the smallest supported persistence scope.',
            citations: [{ source: 'app-source', location: source }],
            original_answer: 'Make the call from the source and use reasonable defaults.',
          },
        ],
      ]),
    );
    expect(urs.open_questions[0].resolution?.decision?.authority).toBe('delegated');
    expect(acceptedDecisionLedger(urs)).toHaveLength(1);

    const draft = planSchema.parse({
      schema_version: 1,
      runtime_version: 1,
      id: 'IOQ',
      title: 'Record IOQ',
      urs_revision: urs.document.revision,
      target: { url, allowed_origins: [url] },
      environment: { timeout_ms: 3000 },
      obligations: [
        {
          id: 'OB-SAVE',
          requirement_id: 'R-SAVE',
          source: 'R-SAVE/statement',
          statement: urs.families[0].requirements[0].statement,
          manual_case_ids: ['OQ-SAVE'],
        },
        {
          id: 'OB-EMPTY',
          requirement_id: 'R-EMPTY',
          source: 'R-EMPTY/statement',
          statement: urs.families[0].requirements[1].statement,
          assertion_ids: ['A-NO-DOWNLOAD'],
        },
      ],
      cases: [
        {
          id: 'OQ-SAVE',
          title: 'Persistence and profile isolation',
          classification: 'OQ',
          requirements: ['R-SAVE'],
          manual: true,
          prerequisites: ['Prepare a disposable persistent browser profile.'],
          manual_procedure:
            'Save a record, restart its browser, verify the record, and compare a separate empty profile.',
          manual_expected:
            'The original profile retains Saved record after restart; a separate profile shows No records.',
          steps: [],
        },
        {
          id: 'OQ-EMPTY',
          title: 'Empty export',
          classification: 'OQ',
          requirements: ['R-EMPTY'],
          steps: [
            {
              id: '01',
              instruction: 'Attempt to export the initially empty record set.',
              actions: [
                { op: 'navigate', url: '/' },
                {
                  op: 'observe_download',
                  locator: { by: 'css', value: '#export' },
                  as: 'empty',
                  timeout_ms: 100,
                },
              ],
              assertions: [
                { id: 'A-NO-DOWNLOAD', variable: 'empty.count', comparison: 'equals', expected: 0 },
              ],
              evidence: [{ id: 'E-EMPTY', kind: 'observation', variable: 'empty' }],
            },
          ],
        },
      ],
      questions: [
        {
          id: 'Q-PREP',
          kind: 'execution_preparation',
          requirement: 'R-SAVE',
          case_ids: ['OQ-SAVE'],
          question: 'Prepare a disposable persistent browser profile.',
        },
      ],
    });
    const conversion = {
      op: 'automate_case',
      case_id: 'OQ-SAVE',
      preserved_manual_expected: draft.cases[0].manual_expected,
      preparation_resolutions: [
        {
          question_id: 'Q-PREP',
          explanation:
            'The trusted browser actions create, restart and clean up disposable persistent profiles automatically.',
        },
      ],
      automated_prerequisites: [
        {
          prerequisite: 'Prepare a disposable persistent browser profile.',
          explanation:
            'The open_profile action creates the disposable profile before saving the record.',
        },
      ],
      steps: [
        {
          id: '01',
          instruction: 'Save the reviewed example and restart its actual browser process.',
          actions: [
            { op: 'browser', command: 'open_profile', name: 'saved', url: '/' },
            { op: 'click', locator: { by: 'css', value: '#save' } },
            { op: 'browser', command: 'restart_profile', name: 'saved' },
          ],
          assertions: [
            {
              id: 'A-SAVED',
              locator: { by: 'css', value: '#records' },
              comparison: 'equals',
              expected: 'Saved record',
            },
          ],
          evidence: [{ id: 'E-SAVED', kind: 'observation' }],
        },
        {
          id: '02',
          instruction: 'Verify an independent profile has no records.',
          actions: [{ op: 'browser', command: 'open_profile', name: 'isolated', url: '/' }],
          assertions: [
            {
              id: 'A-ISOLATED',
              locator: { by: 'css', value: '#records' },
              comparison: 'equals',
              expected: 'No records',
            },
          ],
          evidence: [{ id: 'E-ISOLATED', kind: 'observation' }],
        },
      ],
      coverage: [{ obligation_id: 'OB-SAVE', assertion_ids: ['A-SAVED', 'A-ISOLATED'] }],
    };
    const outputs: unknown[] = [{ plan: draft, fixtures: [] }, { edits: [conversion] }];
    const requests: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, options?: RequestInit) => {
      const request = JSON.parse(String(options?.body));
      requests.push(JSON.parse(request.input[0].content[0].text));
      const value = outputs.shift();
      if (value === undefined) throw new Error('Unexpected provider call.');
      return new Response(
        JSON.stringify({
          status: 'completed',
          usage: { input_tokens: 100, output_tokens: 50 },
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: providerOutputText(options, value) }],
            },
          ],
        }),
      );
    });
    const result = await generatePlan({
      root,
      provider: 'openai',
      key: 'synthetic-key',
      thoroughness: 'standard',
      urs,
      context,
      url,
      fetchImpl,
    });
    expect(result.incomplete, JSON.stringify(result.questions)).toBe(false);
    expect(outputs).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      requests.every((request) => (request.accepted_decisions as unknown[])?.length === 1),
    ).toBe(true);
    expect(result.sourceCorrespondence).toEqual([
      { ...context.hashes[0], deployed_url: `${url}/app.js` },
    ]);
    const final = result.value!.plan;
    expect(final.cases.every((testCase) => !testCase.manual)).toBe(true);
    expect(final.questions).toEqual([]);
    expect(final.cases[1]).toEqual(draft.cases[1]);
    expect(final.cases[0].prerequisites).toEqual([]);
    expect(final.cases[0].manual_expected).toBe(draft.cases[0].manual_expected);
    const rehearsal = await rehearsePlan(root, final, result.value!.fixtures);
    expect(rehearsal.cases.every((testCase) => testCase.status === 'passed')).toBe(true);
    expect(
      rehearsal.observations.find((record) => record.assertion_id === 'A-NO-DOWNLOAD'),
    ).toMatchObject({ status: 'passed', expected: 0, actual: 0 });
    expect(rehearsal.plan_sha256).toBe(
      createHash('sha256').update(JSON.stringify(final)).digest('hex'),
    );
    expect(JSON.stringify(result.diagnostics)).toContain('automate_case');

    await createCandidate(root, urs, final, { pdf: false });
    const approval = await approveCandidate(root, { pdf: false });
    const good = await executePackage(root, approval.package_id, { bindings: {} });
    expect(good.complete).toBe(true);
    expect(good.cases.every((testCase) => testCase.status === 'passed')).toBe(true);
    const report = await renderReport(root, { runId: good.id, pdf: false });
    expect(await readFile(report.html, 'utf8')).toContain('R-SAVE');
    expect(await readFile(report.csv, 'utf8')).not.toContain('manual_pending');

    defective = true;
    const defect = await executePackage(root, approval.package_id, { bindings: {} });
    expect(defect.package_id).toBe(good.package_id);
    expect(defect.cases.find((testCase) => testCase.id === 'OQ-EMPTY')?.status).toBe('failed');
    const observations = (
      await readFile(join(root, 'runs', defect.id, 'observations.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(observations.find((record) => record.assertion_id === 'A-NO-DOWNLOAD')).toMatchObject({
      expected: 0,
      actual: 1,
      status: 'failed',
    });
    expect(defect.artifacts.some((artifact) => artifact.kind === 'download')).toBe(true);
    const defectReport = await renderReport(root, { runId: defect.id, pdf: false });
    expect(await readFile(defectReport.csv, 'utf8')).toContain('failed');
    expect(final.cases[1].steps[0].assertions[0].expected).toBe(0);
  });
});
