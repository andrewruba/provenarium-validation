# Installation and local verification

Use Node.js 26 and npm on macOS or Linux. The repository includes an `.nvmrc` for the tested Node version. No Provenarium account is required. AI authoring uses a separately selected OpenAI or Anthropic API key; offline commands never require one.

## From a checkout

```sh
npm ci
npm run build
npx playwright install chromium
node bin/provenarium.mjs --help
```

On Linux, Chromium may require system libraries. An explicit setup command can install them:

```sh
npx playwright install --with-deps chromium
```

System dependency installation may require administrator access. The `run` command does not install packages or browsers.

## From a prepared release archive

```sh
npm install --global ./provenarium-validation-0.1.0.tgz
provenarium browser install
provenarium --help
```

Install the Chromium version belonging to the installed CLI before execution or PDF rendering. Follow the setup command printed by the CLI if Chromium is missing. A validation project does not need its own `node_modules` directory.

The selected provider key is entered privately when authoring begins. Application credentials are collected separately from the approved access inventory. Session-only storage is the default. Optional persistent credentials use macOS Keychain or Linux Secret Service; a headless Linux machine without an available secret service can continue with session-only input.

## Synthetic demonstration

Start the example in one terminal:

```sh
node examples/sample-app/server.ts --port 4173
```

An installed archive also includes the compiled sample server at
`<package-directory>/dist/examples/sample-app/server.js`; run that file with Node
using the same options. Programmatic consumers can import
`provenarium-validation/example`.

The default variant rejects duplicate sample identifiers. A deliberate defect can be demonstrated in a fresh data directory:

```sh
node examples/sample-app/server.ts --port 4173 --defective --data-dir /tmp/provenarium-defective-data
```

Public synthetic account values live in `examples/sample-app/credentials.example.json`. They are demonstration credentials only; do not use them for production accounts or copy them into an approved validation package. The example plan expects an empty data directory at the beginning of each qualification run.

The reviewed URS, test plan, input fixtures, and independent calculation examples are in `examples/sample-validation`. To walk through the provider-free workflow with the built checkout:

```sh
cp -R examples/sample-validation /tmp/my-validation
node bin/provenarium.mjs --project /tmp/my-validation generate --urs urs.yaml --plan /tmp/my-validation/plan.json
node bin/provenarium.mjs --project /tmp/my-validation approve
node bin/provenarium.mjs --project /tmp/my-validation run
node bin/provenarium.mjs --project /tmp/my-validation report
```

Review the generated IOQ before accepting the approval prompt. Supply the named synthetic accounts when `run` asks. The manual recovery case remains pending, so the run command returns a nonzero status even when all automated cases pass. Run `report` separately to inspect those results.

The deterministic end-to-end test exercises both application variants using one approval:

```sh
npm run build
npm run test:e2e
```

To retain the generated documents and evidence for inspection:

```sh
KEEP_E2E_ARTIFACTS=1 npm run test:e2e
```

The test prints the retained validation-project path. The recovery-evidence case is deliberately manual and remains pending in both runs.

## Release verification

```sh
npm run check
npm run test:e2e
npm pack
```

CI runs these checks on macOS and Ubuntu Linux, including a clean tarball installation outside the checkout. CI makes no paid provider requests. Real-provider evaluations are a separate, explicitly invoked development activity with a visible per-command spending ceiling.
