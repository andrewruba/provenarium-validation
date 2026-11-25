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

## From a GitHub release

Download `provenarium-validation-0.1.0.tgz` and `SHA256SUMS` from the
[v0.1.0 release](https://github.com/andrewruba/provenarium-validation/releases/tag/v0.1.0).
One archive supports macOS and Linux with Node.js 26 and npm. It includes compiled
JavaScript; npm downloads the runtime dependencies, including the native
credential-store package for your platform. The included `npm-shrinkwrap.json`
locks dependency versions. This is a prerelease while live
provider authoring evaluations remain pending. Windows is not currently verified.

Verify the downloaded archive against its checksum (use `sha256sum --check
SHA256SUMS` on Linux):

```sh
shasum --algorithm 256 --check SHA256SUMS
```

Then install it:

```sh
npm install --global ./provenarium-validation-0.1.0.tgz
provenarium browser install
provenarium --help
```

You can also install directly from the versioned asset URL:

```sh
npm install --global https://github.com/andrewruba/provenarium-validation/releases/download/v0.1.0/provenarium-validation-0.1.0.tgz
```

Use a Node version manager or an npm prefix writable by your account if your
global installation directory needs elevated permissions. No automatic elevation
is attempted. The package is distributed through GitHub Releases, not the npm
registry. The automatically generated GitHub source archives are source code;
choose the `.tgz` release asset for installation.

To update, install the archive or exact asset URL for the desired release using
the same command. Run `provenarium browser install` again after updating, then
check `provenarium --version`.

Install the Chromium version belonging to the installed CLI before execution or PDF rendering. Follow the setup command printed by the CLI if Chromium is missing. A validation project does not need its own `node_modules` directory.

The selected provider key is entered privately when authoring begins. Application credentials are collected separately from the approved access inventory. Session-only storage is the default. Optional persistent credentials use macOS Keychain or Linux Secret Service; a headless Linux machine without an available secret service can continue with session-only input.

## Uninstall

```sh
provenarium uninstall --dry-run   # Inspect the verified installation and command
provenarium uninstall             # Confirm removal interactively
provenarium uninstall --yes       # Explicitly remove without a prompt
```

The command verifies that the running CLI belongs to the active npm global
installation, then asks npm to remove that package from its exact prefix. It
refuses source checkouts, local installs, `npx` caches, linked packages, or a
different npm installation. Use the same Node/npm environment that installed
the tool. The package-manager equivalent is:

```sh
npm uninstall --global provenarium-validation
```

Validation projects, reports, saved credentials, and the shared Playwright
browser cache are retained. To remove provider keys, do so before uninstalling:

```sh
provenarium auth forget --provider openai
provenarium auth forget --provider anthropic
```

For a local npm dependency, run `npm uninstall provenarium-validation` in that
project. A source checkout is not an installed global package; remove the checkout
manually only after retaining any work you need.

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

The release workflow builds one archive, verifies that exact archive on both
operating systems (including global installation and removal), and publishes it
with checksums only after all checks pass. See [release maintenance](releasing.md).
