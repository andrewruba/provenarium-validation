# Provenarium Validation

Provenarium turns reviewed software requirements into a readable qualification
protocol, Playwright tests, and execution evidence.

```sh
provenarium validate --context ../my-app --url https://app.example.com
```

Review the proposed requirements and approve the resulting URS. Provenarium
then writes the IOQ and tests, dry-runs them in Chromium, executes the checked
tests, and prints the summary and report path. The dry run applies confirmed
locator fixes in one pass and reruns the tests with the same expected results.
If a failure needs review, Provenarium prints the observed results and saves the
IOQ and diagnostics. Run the same command after addressing the failure.

Run `provenarium validate` in a project to use its saved inputs or enter them at
the prompts. See the [CLI reference](docs/cli-reference.md).

## Install

Use Node.js 26 and npm on macOS or Linux. From a checkout.

```sh
npm ci
npm pack
npm install --global ./provenarium-validation-0.1.3.tgz
```

The first validation installs the required Chromium build if it is missing.
See the [installation guide](docs/installation.md) for archive verification and
Linux system libraries.

## Try the demo

Dilution Bench is a browser-based dilution calculator with local records and
CSV export. In a fresh validation project, run:

```sh
provenarium validate --context /path/to/provenarium-validation/examples/dilution-pages \
  --url https://andrewruba.github.io/provenarium-validation/correct/
```

Use a separate project to try the [deliberately faulty app](https://andrewruba.github.io/provenarium-validation/faulty/).
The same validation flow applies to both. See the [demo guide](docs/testing-hosted-dilution.md).

## Verify changes

```sh
npm run check
npm run test:e2e
npm run verify:package
```

Repository checks use scripted provider responses and real Chromium. See the
[verification status](docs/verification-status.md) for the published results.
