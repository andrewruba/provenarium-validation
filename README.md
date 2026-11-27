# Provenarium Validation

A command-line tool project for software validation in pharma and other GxP
workflows, centered on user requirements, readable protocols, and test evidence.

## Workflow

```sh
provenarium validate --context ../my-app --url https://app.example.com
```

The CLI prepares a draft User Requirements Specification (URS) from the source
and deployed app. Review any proposed answers and approve the resulting URS.
That approval authorizes synthetic browser tests on the displayed deployment.
The CLI then generates the readable IOQ and Playwright tests, runs a browser dry
run, and, if it passes, executes the checked tests and prints the summary and report path.

To start with a requirements file you already have, run
`provenarium validate --urs urs.yaml`. A new project can also start with just
`provenarium validate` and enter its source and URL at the prompts.

The dry run can retry once after narrowing an ambiguous locator to a unique
exact match. Application failures and other test problems are retained with the
IOQ and dry run results. Address the reported issue and run `provenarium validate`
again to check the saved tests. Pass `--urs` again if you used a different
requirements filename. After a successful dry run, the CLI freezes the exact
plan and inputs for execution and prints the final summary and report location.

The individual `urs`, `generate`, `approve`, `run`, and `report` commands remain
available for teams that manage each step separately. [CLI reference](docs/cli-reference.md)

## Installation and use

Use Node.js 26 on macOS or Linux. Install the
[v0.1.0 prerelease](https://github.com/andrewruba/provenarium-validation/releases/tag/v0.1.0)
directly from its GitHub release archive:

```sh
npm install --global https://github.com/andrewruba/provenarium-validation/releases/download/v0.1.0/provenarium-validation-0.1.0.tgz
provenarium browser install
provenarium --help
```

The archive works on both supported operating systems; npm downloads the runtime
dependencies for your platform. Chromium is installed separately. See the
[installation guide](docs/installation.md) for checksums, updates, and removal.
Uninstall the CLI with `provenarium uninstall` (or `--yes` for unattended use).

To run from a source checkout instead:

```sh
npm ci
npm run build
node bin/provenarium.mjs browser install
node bin/provenarium.mjs --help
```

OpenAI and Anthropic authoring use a spending ceiling shown before the first
provider call. `validate` shares it across requirements drafting, recommendations,
and test authoring. The browser dry run, execution, and reporting run locally.

Read the [CLI reference](docs/cli-reference.md), [installation and demonstration
guide](docs/installation.md), [URS writing guide](docs/urs-writing-guide.md), and
[troubleshooting guide](docs/troubleshooting.md).

The synthetic example includes one working application and a deliberate defect
tested under the same approved package. Run the deterministic checks with:

```sh
npm run check
npm run test:e2e
npm run verify:package
```

Live-provider authoring quality evaluations remain pending; fixture-based tests
verify adapters and spending controls without paid calls. Releases are distributed
on GitHub; the package is not published to the npm registry.
See [verification status](docs/verification-status.md) for completed
checks and pending evaluations, and [release notes](CHANGELOG.md) for the
implementation boundary.

## Scientific validation sandbox

Try the browser-only **Dilution Bench** demos on GitHub Pages:

- [Corrected app](https://andrewruba.github.io/provenarium-validation/correct/)
- [Deliberately faulty app](https://andrewruba.github.io/provenarium-validation/faulty/)

Both use the standard `C₁V₁ = C₂V₂` dilution equation, unit selection, browser-local
preparation records, and CSV export. The faulty version has four deliberate
calculation, input, duplicate-record, and export defects. Independent requirements
and reference calculations define the intended results.

```sh
npm run validate:dilution:pages -- \
  --correct-url https://andrewruba.github.io/provenarium-validation/correct/ \
  --faulty-url https://andrewruba.github.io/provenarium-validation/faulty/
```

The prepared comparison uses the main CLI without provider calls and retains
reports and evidence locally. Expect 11 passes for the corrected app and seven
passes plus four failures for the faulty app. Read the [CLI testing guide](docs/testing-hosted-dilution.md)
for step-by-step commands, AI authoring, data isolation, and report interpretation.

`npm run demo:pages` previews both static versions locally. GitHub Actions publishes
them after verification passes on `main`; see the [deployment guide](docs/deployment.md).
The **Published Pages validation** workflow checks the live site and retains its
reports. The [original Node example](examples/dilution-app/README.md) remains
available with `npm run demo:dilution` and `npm run validate:dilution` for backend
HTTP validation scenarios.
