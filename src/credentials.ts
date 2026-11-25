import { confirm, isCancel, password, select, text } from '@clack/prompts';
import { chromium } from '@playwright/test';
import { mkdir, chmod, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import type { Access, Bindings, Plan } from './schema.js';

function answer<T>(value: T): Exclude<T, symbol> {
  if (isCancel(value))
    throw new Error('Credential preparation cancelled; execution has not started.');
  return value as Exclude<T, symbol>;
}

function requireTerminal(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Credential input requires an interactive terminal. Supply bindings through the programmatic API or provision secure storage before running.',
    );
  }
}

async function credentialEntry(name: string) {
  const { Entry } = await import('@napi-rs/keyring');
  return new Entry('provenarium-validation', name, { linux: { store: 'secret-service' } });
}

export async function readStoredSecret(name: string): Promise<string | undefined> {
  try {
    return (await credentialEntry(name)).getPassword() ?? undefined;
  } catch {
    return undefined;
  }
}

export async function saveStoredSecret(name: string, value: string): Promise<boolean> {
  try {
    (await credentialEntry(name)).setPassword(value);
    return true;
  } catch {
    return false;
  }
}

export async function getProviderKey(
  provider: 'openai' | 'anthropic',
  options: { remember?: boolean } = {},
): Promise<string> {
  const stored = await readStoredSecret(`provider:${provider}`);
  if (stored) return stored;
  requireTerminal();
  const value = answer(
    await password({
      message: `Paste ${provider} API key`,
      validate: (value) => (value?.trim() ? undefined : 'A key is required.'),
    }),
  ).trim();
  const remember =
    options.remember ??
    answer(
      await confirm({
        message: 'Remember this key in the operating-system credential store?',
        initialValue: false,
      }),
    );
  if (remember && !(await saveStoredSecret(`provider:${provider}`, value))) {
    process.stderr.write(
      'Secure credential storage is unavailable. This key will be used for this command only.\n',
    );
  }
  return value;
}

export async function forgetProviderKey(provider: 'openai' | 'anthropic'): Promise<void> {
  try {
    (await credentialEntry(`provider:${provider}`)).deletePassword();
  } catch (error) {
    // Only an explicit missing entry is equivalent to successful removal.
    // An unavailable/locked backend may still contain the credential.
    if (
      error instanceof Error &&
      /no (?:matching )?(?:credential|entry|password|secret)(?: was)? found|(?:credential|entry|password|secret) (?:was )?not found|NoEntry|the specified item could not be found/i.test(
        error.message,
      )
    )
      return;
    throw new Error(
      `The stored ${provider} credential could not be removed. Unlock or restore the operating-system credential store and retry.`,
    );
  }
}

export function validateBindings(access: Access[], bindings: Bindings, plan?: Plan): void {
  for (const actor of access) {
    if (actor.mode === 'anonymous') continue;
    const supplied = bindings[actor.id];
    if (!supplied?.username)
      throw new Error(`Missing account identifier for ${actor.id}; execution has not started.`);
    if (actor.mode === 'session' && !supplied.storageState)
      throw new Error(`Missing authenticated session for ${actor.id}; execution has not started.`);
    if (actor.mode === 'credentials' && !supplied.password && !supplied.token)
      throw new Error(`Missing credential for ${actor.id}; execution has not started.`);
    for (const other of actor.distinct_from) {
      if (bindings[other]?.username === supplied.username)
        throw new Error(`${actor.id} and ${other} require distinct account identifiers.`);
    }
  }
  if (plan)
    for (const testCase of plan.cases)
      for (const step of testCase.steps)
        for (const action of step.actions) {
          const reference =
            action.op === 'fillSecret'
              ? action.binding
              : action.op === 'request'
                ? action.auth_binding
                : undefined;
          if (!reference) continue;
          const [actor, field, ...extra] = reference.split('.');
          if (
            extra.length ||
            !['username', 'password', 'token'].includes(field) ||
            !access.some((item) => item.id === actor)
          ) {
            throw new Error(
              `Invalid approved credential reference ${reference}; execution has not started.`,
            );
          }
          if (!bindings[actor]?.[field as 'username' | 'password' | 'token']) {
            throw new Error(`Missing credential binding ${reference}; execution has not started.`);
          }
        }
}

export async function prepareBindings(
  access: Access[],
  root: string,
  targetUrl: string,
  plan?: Plan,
): Promise<Bindings> {
  const bindings: Bindings = {};
  if (!access.some((actor) => actor.mode !== 'anonymous')) return bindings;
  requireTerminal();
  process.stdout.write(`Application access required for ${new URL(targetUrl).origin}\n`);
  for (const actor of access) {
    process.stdout.write(
      `${actor.id}: ${actor.role}; ${actor.state}; ${actor.purpose}; cases: ${actor.cases.join(', ')}\n`,
    );
    if (actor.mode === 'anonymous') continue;
    const confirmed = answer(
      await confirm({
        message: `Confirm a ${actor.state} ${actor.role} account${actor.organization ? ` in ${actor.organization}` : ''} is prepared for ${actor.id}`,
        initialValue: false,
      }),
    );
    if (!confirmed)
      throw new Error(`Account preparation incomplete for ${actor.id}; execution has not started.`);
    const username = answer(
      await text({
        message: `${actor.id} username`,
        validate: (value) => (value?.trim() ? undefined : 'An account identifier is required.'),
      }),
    ).trim();
    if (actor.mode === 'credentials') {
      const identity = createHash('sha256')
        .update(`${new URL(targetUrl).origin}:${actor.id}:${username}`)
        .digest('hex');
      const stored = await readStoredSecret(`application:${identity}`);
      if (stored) {
        let parsed: Bindings[string] | undefined;
        try {
          parsed = JSON.parse(stored) as Bindings[string];
        } catch {
          /* Ignore malformed legacy entries. */
        }
        if (
          parsed?.username === username &&
          (typeof parsed.password === 'string' || typeof parsed.token === 'string')
        ) {
          const reuse = answer(
            await confirm({
              message: `Reuse the securely stored credential for ${actor.id}?`,
              initialValue: false,
            }),
          );
          if (reuse) {
            bindings[actor.id] = { username, password: parsed.password, token: parsed.token };
            continue;
          }
        }
      }
      const requiredFields = new Set(
        plan?.cases
          .flatMap((testCase) =>
            testCase.steps.flatMap((step) =>
              step.actions.flatMap((action) => {
                const reference =
                  action.op === 'fillSecret'
                    ? action.binding
                    : action.op === 'request'
                      ? action.auth_binding
                      : undefined;
                return reference?.startsWith(`${actor.id}.`) ? [reference.split('.')[1]] : [];
              }),
            ),
          )
          .filter((field) => field !== 'username'),
      );
      const credentialType =
        requiredFields.size === 1
          ? ([...requiredFields][0] as 'password' | 'token')
          : answer(
              await select({
                message: `Credential required for ${actor.id}`,
                options: [
                  {
                    value: 'password',
                    label:
                      actor.state === 'incorrect_password'
                        ? 'Deliberately incorrect password'
                        : 'Password',
                  },
                  {
                    value: 'token',
                    label: 'API token (only for an approved token-binding procedure)',
                  },
                ],
              }),
            );
      const value = answer(
        await password({
          message: `${actor.id} ${credentialType}`,
          validate: (value) => (value ? undefined : 'A credential is required.'),
        }),
      );
      bindings[actor.id] = { username, [credentialType]: value };
      if (requiredFields.size > 1) {
        const other = credentialType === 'password' ? 'token' : 'password';
        bindings[actor.id][other] = answer(
          await password({
            message: `${actor.id} ${other}`,
            validate: (value) => (value ? undefined : 'A credential is required.'),
          }),
        );
      }
      const remember = answer(
        await confirm({
          message: `Remember ${actor.id} credential in the operating-system store?`,
          initialValue: false,
        }),
      );
      if (remember) {
        if (
          !(await saveStoredSecret(`application:${identity}`, JSON.stringify(bindings[actor.id])))
        )
          process.stderr.write(
            'Secure storage unavailable; the credential remains session-only.\n',
          );
      }
      continue;
    }
    const authDirectory = join(resolve(root), '.provenarium', 'auth');
    await mkdir(authDirectory, { recursive: true, mode: 0o700 });
    await chmod(authDirectory, 0o700);
    const statePath = join(authDirectory, `${actor.id}.json`);
    let exists = false;
    try {
      exists = (await stat(statePath)).isFile();
    } catch {
      /* first use */
    }
    const reuse =
      exists &&
      answer(
        await confirm({ message: `Reuse the saved session for ${actor.id}?`, initialValue: false }),
      );
    if (!reuse) {
      let browser;
      try {
        browser = await chromium.launch({ headless: false });
      } catch {
        throw new Error(
          'Chromium is unavailable. Install the Playwright Chromium browser using the documented setup command.',
        );
      }
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(targetUrl);
        const signedIn = answer(
          await confirm({
            message: `Sign in in the browser (including SSO/MFA), then confirm ${actor.id} is ready.`,
            initialValue: false,
          }),
        );
        if (!signedIn) throw new Error(`Session preparation cancelled for ${actor.id}.`);
        await context.storageState({ path: statePath });
        await chmod(statePath, 0o600);
      } finally {
        await browser.close();
      }
    }
    bindings[actor.id] = { username, storageState: statePath };
  }
  validateBindings(access, bindings, plan);
  return bindings;
}

/** Only excluded authentication storage may be supplied as a saved session. */
export function assertSessionLocation(root: string, statePath: string): string {
  const base = resolve(root, '.provenarium', 'auth');
  const full = resolve(statePath);
  const rel = relative(base, full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel))
    throw new Error('Authentication state must be inside .provenarium/auth.');
  return full;
}
