# Test the CLI against the GitHub Pages demos

The published targets are a standard `C₁V₁ = C₂V₂` dilution calculator with unit
selection, saved preparations, and CSV downloads:

- [Corrected version](https://andrewruba.github.io/provenarium-validation/correct/)
- [Faulty version](https://andrewruba.github.io/provenarium-validation/faulty/)

The browser-only protocol has 11 independent cases. Expected results are **11
passed** for corrected behavior and **7 passed / 4 failed** for faulty behavior:

| Case | Deliberate defect |
| --- | --- |
| `OQ-UNIT-CONVERSION` | Incorrect microgram concentration conversion |
| `OQ-ZERO-VOLUME` | Zero final volume accepted |
| `OQ-DUPLICATE-ID` | Duplicate identifier replaces the original preparation |
| `OQ-CSV-EXPORT` | Stock volume exported in the wrong units |

Requirements and expected calculations are defined independently in
[`examples/dilution-pages-validation`](../examples/dilution-pages-validation/).
The checks use the browser UI and downloads. There are no backend API, server-side
validation, authentication, or cross-user persistence claims in this fixture.

## Install and run the prepared comparison

From a checkout with Node.js 26:

```sh
npm ci
npm run build
node bin/provenarium.mjs browser install
npm run validate:dilution:pages -- \
  --correct-url https://andrewruba.github.io/provenarium-validation/correct/ \
  --faulty-url https://andrewruba.github.io/provenarium-validation/faulty/
```

This uses the real main CLI to generate, approve, execute, and report each target.
It makes no provider calls and requires no API key. It automatically approves the
supplied reviewed fixture; inspect and approve your own generated protocols using
the manual workflow below.

The comparison command succeeds only when it observes the exact expected
outcomes. The normal `provenarium run` command still returns nonzero for a failed
qualification. Reports, observations, screenshots, CSV traceability, and CLI logs
are retained under `.demo-results/`; the terminal prints their locations. Use
`--output <parent-directory>` to choose another location or `--pdf` to add PDFs.

The targets have different URLs, so each receives a separate approval. The source
requirements and expected outcomes remain identical. `--commit <full-SHA>` can
require matching build metadata when checking a specific deployment.

## Use the main CLI step by step

Prepare a fresh project and scope its browser storage:

```sh
node scripts/prepare-pages-dilution.mjs \
  --url https://andrewruba.github.io/provenarium-validation/correct/ \
  --project .demo-results/pages-correct
node bin/provenarium.mjs --project .demo-results/pages-correct urs check urs.yaml
node bin/provenarium.mjs --project .demo-results/pages-correct generate \
  --urs urs.yaml --plan plan.json
```

The helper writes the URS, independent references, target metadata, and a prepared
plan bound to a random browser workspace. It does not approve or execute anything
and refuses to overwrite an existing project. Review the generated IOQ and its
expectations, then run:

```sh
node bin/provenarium.mjs --project .demo-results/pages-correct approve
node bin/provenarium.mjs --project .demo-results/pages-correct run --release-label pages-correct
node bin/provenarium.mjs --project .demo-results/pages-correct report
```

Repeat using `/faulty/` and a different project directory. Reporting should run
even after the expected nonzero exit from a faulty run; do not connect those two
commands with `&&`. HTML/PDF reports compare expected and actual observations;
the CSV traceability file maps requirements to the results. Report rendering uses
retained evidence without revisiting the application.

## Test AI authoring

Create another project with `prepare-pages-dilution.mjs`, then use the complete
workspace URL it prints, including `?workspace=...`:

```sh
node scripts/prepare-pages-dilution.mjs \
  --url https://andrewruba.github.io/provenarium-validation/faulty/ \
  --project .demo-results/pages-ai
node bin/provenarium.mjs --project .demo-results/pages-ai generate \
  --urs urs.yaml \
  --url 'https://andrewruba.github.io/provenarium-validation/faulty/?workspace=YOUR-WORKSPACE-ID' \
  --provider openai --thoroughness standard --interactive-discovery
```

Replace the example workspace ID with the helper's actual value. Use
`--provider anthropic` to test the other provider. This route incurs API usage
under the displayed spending ceiling. Omit `--plan` to request AI authoring; the
copied prepared plan is not selected by that command. For a blind exercise, do
not link the prepared plan, application source, or defect guide as authoring
context. Review expectations against the URS and reference calculations rather
than accepting whatever values the faulty app displays.

Generated cases must establish their own test data. The runner uses a fresh
browser context for each case, so browser storage is not shared between cases.
Keep the target URL fixed after approval. In a manual browser session, click
**Clear preparations** before repeating a procedure or after exploratory data
entry. Then use the normal `approve`, `run`, and `report` commands.

## Browser data and scope

Calculations execute in JavaScript and records are saved in local storage for the
current browser, app version, URL path, and workspace. Corrected and faulty data
are separate even though both versions use the same origin. No preparation data
is sent to a server. Reloading or changing the visible screen preserves records
within that browser context. Clearing preparations affects only that workspace.

The test runner starts each case with its own browser context. Cases are
self-contained and explicitly establish the records they need. Browser-local
persistence can be tested within a case; shared server persistence cannot.
Workspaces are not authentication and these are synthetic examples, not laboratory
procedures. The app bounds each browser workspace to 500 records and surfaces
storage failures.

## Validate live Pages in GitHub Actions

After the Pages deployment completes, open **Actions → Published Pages validation
→ Run workflow**. The default URLs point to the two published versions. Select
the branch whose commit is deployed. This workflow requires matching deployment
metadata and uploads `pages-dilution-evidence-…` for 14 days, including reports from
failed comparisons. No model-provider or hosting secret is required.

For local static testing, start `npm run demo:pages` and substitute
`http://127.0.0.1:4176/correct/` and `http://127.0.0.1:4176/faulty/` in the same
comparison command.

The older `npm run validate:dilution` exercises the original Node demonstration,
including its HTTP interface. Its fixture and the browser-only Pages fixture are
intentionally distinct because they verify different application capabilities.
