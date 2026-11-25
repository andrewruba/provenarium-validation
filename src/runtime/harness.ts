import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { planSchema } from '../schema.js';
import { ExecutionEngine } from './engine.js';
import { receiveBindings } from './ipc.js';
import type { WorkerContext } from './io.js';

const contextPath = process.env.PROVENARIUM_RUN_CONTEXT;
if (!contextPath) throw new Error('Use provenarium run to execute an approved package.');
const settings = JSON.parse(await readFile(contextPath, 'utf8')) as WorkerContext;
const plan = planSchema.parse(
  JSON.parse(await readFile(join(settings.packageDirectory, 'plan.json'), 'utf8')),
);
const bindings = await receiveBindings(settings.socketPath);
const runtime = new ExecutionEngine(settings, plan, bindings);
test.beforeAll(async ({ browser }) => {
  await runtime.setBrowser(browser);
});
const require = createRequire(import.meta.url);
for (const file of settings.tests) {
  const register = require(file);
  if (typeof register !== 'function')
    throw new Error('Approved executable test does not expose the compiler registration function.');
  register({ test, expect, runtime });
}
