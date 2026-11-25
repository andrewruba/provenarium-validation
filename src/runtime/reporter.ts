import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { readFile } from 'node:fs/promises';
import { updateRun, type WorkerContext } from './io.js';

/** Persist runner-level failures without exporting raw Playwright diagnostics. */
export default class QualificationReporter implements Reporter {
  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    if (result.status === 'passed') return;
    const contextPath = process.env.PROVENARIUM_RUN_CONTEXT;
    if (!contextPath) return;
    const context = JSON.parse(await readFile(contextPath, 'utf8')) as WorkerContext;
    await updateRun(context.runDirectory, (run) => {
      const entry = run.cases.find(
        (item) => item.id === test.title || test.title.startsWith(`${item.id} `),
      );
      if (entry?.status === 'not_run') {
        entry.status = result.status === 'skipped' ? 'not_run' : 'blocked';
        entry.message =
          'The browser runner did not retain a completed case. Check browser/session prerequisites.';
      }
    });
  }
}
