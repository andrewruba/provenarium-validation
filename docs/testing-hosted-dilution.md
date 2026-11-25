# Test the CLI against the hosted dilution demos

The two services run the same scientific dilution app in corrected and deliberately
faulty modes. The prepared protocol has 11 cases. The corrected app should pass
all 11; the faulty app should pass seven and fail these four:

| Case | Expected defect |
| --- | --- |
| `OQ-UNIT-CONVERSION` | Incorrect µg/mL conversion |
| `OQ-ZERO-VOLUME` | Zero final volume accepted |
| `OQ-DUPLICATE-ID` | Original record replaced by a duplicate |
| `OQ-CSV-EXPORT` | Stock volume exported with incorrect units |

Set up the services with the [deployment guide](deployment.md). Copy their actual
HTTPS URLs from Render; the example hostnames below are placeholders. No provider
API key is needed for the prepared protocol.

## Install the CLI from this checkout

Use Node.js 26:

```sh
npm ci
npm run build
node bin/provenarium.mjs browser install
```

## Run the complete hosted comparison

```sh
npm run validate:dilution:hosted -- \
  --correct-url https://YOUR-CORRECT-SERVICE.onrender.com \
  --faulty-url https://YOUR-FAULTY-SERVICE.onrender.com
```

The command waits for each service to wake, checks that its advertised mode is
correct, allocates a fresh test workspace on each service, and uses the **main
CLI commands** to generate, approve, execute, and report the prepared protocol.
It retains all generated files and reports under `.demo-results/` and prints their
locations. `--output <directory>` chooses another parent directory; `--pdf` adds
PDF reports.

This demonstration helper automatically approves the supplied, reviewed fixture.
For a protocol you authored yourself, use the manual workflow below and inspect
it before approval.

The comparison exits successfully only when corrected behavior passes all cases
and faulty behavior produces exactly the four expected failures. A normal
`provenarium run` against the faulty service still exits nonzero. Unexpected
failures, missing cases, blocked steps, a workspace reset, or the wrong service
mode make the comparison fail. Failures retain evidence for investigation.

The two services have different target URLs, so they need **separate approved
packages**. The supplied procedures and expected results are the same; only the
target and workspace paths change. The local `npm run validate:dilution` comparison
can reuse one approval because it changes behavior behind a single target URL.

To require a particular deployed revision, add `--commit <full-Git-commit-SHA>`.
The helper checks the server's reported commit. This is a useful deployment check,
not independent proof that running code matches a source revision.

## Walk through the main CLI yourself

Prepare a new project for the corrected service:

```sh
node scripts/prepare-dilution.mjs \
  --url https://YOUR-CORRECT-SERVICE.onrender.com \
  --project .demo-results/my-correct-validation

node bin/provenarium.mjs --project .demo-results/my-correct-validation urs check urs.yaml
node bin/provenarium.mjs --project .demo-results/my-correct-validation generate \
  --urs urs.yaml --plan plan.json
```

The preparation helper copies the requirements and independent calculation
references, assigns a fresh workspace URL, and adjusts the supplied procedures to
that target. It does not approve or execute anything and refuses to overwrite an
existing project. Open the generated IOQ and review the procedure, expected values,
coverage, and target before continuing. Open the printed workspace URL and wait
until the app loads; its `health` endpoint should return HTTP 200. Free services
can take about a minute to wake, longer than an individual protocol step's
timeout. Warm the service again if it has been idle for 15 minutes:

```sh
node bin/provenarium.mjs --project .demo-results/my-correct-validation approve
node bin/provenarium.mjs --project .demo-results/my-correct-validation run \
  --release-label dilution-correct
node bin/provenarium.mjs --project .demo-results/my-correct-validation report
```

Repeat with the faulty service URL and a different project directory such as
`.demo-results/my-faulty-validation`. Label that run `dilution-faulty`. Run `report`
after the expected nonzero `run` exit; do not join those two commands with `&&`.

HTML and PDF executed records show expected versus actual observations, screenshots,
and failed steps. The CSV traceability file maps requirements to case results.
Reporting uses retained evidence and does not contact the application again.

## Test AI authoring instead of the supplied protocol

Prepare another fresh project with the helper, then use its printed **workspace
URL**, including the entire `/w/<id>/` path:

```sh
node bin/provenarium.mjs --project .demo-results/my-ai-validation generate \
  --urs urs.yaml --url https://YOUR-SERVICE.onrender.com/w/YOUR-WORKSPACE-ID/ \
  --provider openai --thoroughness standard --interactive-discovery
```

Create `.demo-results/my-ai-validation` with `prepare-dilution.mjs` first. Omit
`--plan` for AI authoring. The copied prepared plan is not selected as authoring
input by this command. For a blind exercise, do not link that plan, the app's
source, or `DEFECTS.md` as context. Use `--provider anthropic` to test Anthropic.
This path requires your provider key and incurs API usage under the displayed
spending ceiling; it is separate from the offline checks.

Review the generated protocol against the independent URS and reference
calculations. Discovery can create synthetic records: open the same workspace
URL and click **Clear preparations** before running the approved protocol. Keep
the workspace URL unchanged after approval. Then use the same `approve`, `run`,
and `report` sequence as above with your AI project directory.

## Fresh data and repeat runs

Each `/w/<id>/` workspace has its own records. Use the helper-generated random IDs
and one workspace per project. The unscoped homepage is a shared scratchpad and
should not be used for a reproducible hosted qualification.

For a repeat run of an existing approval, click **Clear preparations** inside
its workspace immediately before the run. This clears that workspace only. It
does not change the approval, procedures, or other visitors' workspaces. The
prepared protocol creates fixed sample IDs and expects no pre-existing records.
Do not clear a workspace while a run is in progress.

Workspaces are disposable: they expire after an hour without activity, and a
service restart, redeploy, or free-instance sleep clears in-memory records. The
automated comparison checks a workspace generation identifier before and after
execution and rejects evidence assembled across a reset. Manual CLI use does not
add this demo-specific check automatically; avoid deployments during a run and
investigate interrupted or inconsistent results. A workspace URL is not an
authentication mechanism; use synthetic data only.

The demo bounds the number of active workspaces and records. If it reports
capacity exhaustion, allow unused workspaces to expire or restart the demo
service when no tests are running. No paid database is required.

## Run hosted validation in GitHub Actions

After both Render services show the intended commit as live:

1. Open this repository's **Actions → Hosted dilution validation** workflow.
2. Choose **Run workflow**, select the deployed branch/revision, and supply the
   corrected and faulty service URLs.
3. Read the comparison output. Download **hosted-dilution-evidence-…** from the
   run's artifacts for the reports and observations; artifacts are kept for
   14 days, including on failed comparisons.

The workflow requires both services to report the workflow's commit SHA. It uses
no provider key or Render API secret. The workflow is manual and separate from
the pre-deployment checks: putting a test that waits for deployment into the same
CI gate would prevent Render from deploying. Run it again after a deployment when
you want fresh hosted evidence; it creates new workspaces automatically.
