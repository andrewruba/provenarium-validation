# Dilution Bench

A small laboratory dilution planner for exercising Provenarium validation.
Prepare a dilution with `C₁V₁ = C₂V₂`, view retained preparation records, and
download CSV. Concentrations support mg/mL and µg/mL; final volumes support mL
and µL. It uses synthetic data, requires no accounts, and defaults to loopback.

This is the original Node/HTTP example. The published GitHub Pages demos use a
separate browser-only implementation and protocol: see
[CI/CD deployment](../../docs/deployment.md) and
[testing the main CLI against Pages](../../docs/testing-hosted-dilution.md).

## Start the app

From the repository root with Node.js 26 and dependencies installed:

```sh
npm run demo:dilution
```

Open **http://127.0.0.1:4174**. The default is deliberately faulty. The UI looks
the same in both modes so validation must judge behavior against the requirements.
Try stock **10 mg/mL**, target **2 mg/mL**, and final volume **10 mL**: the expected
preparation is **2.000 mL stock + 8.000 mL diluent**.

Stop with Ctrl+C. Restarting empties the in-memory records; browser reloads and
navigation preserve them while the process runs. There is no backup or persistent
database in this exercise.

```sh
# Corrected behavior
npm run demo:dilution -- --mode correct

# Enable only a selected defect (or a comma-separated list)
npm run demo:dilution -- --defects concentration-units

# Optional alternate port; update a validation plan's target before approving it
npm run demo:dilution -- --port 4180
```

## Validate without provider calls

Install Chromium once if needed, then run the complete comparison:

```sh
node bin/provenarium.mjs browser install
npm run validate:dilution
```

The command builds the project, starts its own app on a free port, compiles and
approves the supplied demonstration protocol, runs the faulty app, clears records,
and runs corrected behavior against the **same approved package**. It closes its
server afterward. A separately opened demo server does not affect this comparison.

The protocol has 11 cases. Expected outcome: **seven passed and four failed** in
faulty mode, and **all 11 passed** in corrected mode. The comparison command exits
zero only when those expected outcomes occur; a normal `provenarium run` exits
nonzero for failed cases.
This is a check that the validator detects the seeded defects, not acceptance of
the faulty application.

The terminal prints paths to retained HTML reports, screenshots, observations,
CSV traceability, and `comparison.json` under `.demo-results/dilution/` (ignored by
Git). Each invocation creates a new directory. Optional PDF reports and an output
parent directory are available:

```sh
npm run validate:dilution -- --pdf --output .demo-results/my-dilution-check
```

For the ordinary CLI workflow, start a fresh default app on port 4174 and use:

```sh
node bin/provenarium.mjs --project examples/dilution-validation urs check urs.yaml
node bin/provenarium.mjs --project examples/dilution-validation generate --urs urs.yaml --plan plan.json
# Read the generated IOQ before approving it.
node bin/provenarium.mjs --project examples/dilution-validation approve
node bin/provenarium.mjs --project examples/dilution-validation run --release-label dilution-faulty
# A failed run is expected; run reporting even though run returned nonzero.
node bin/provenarium.mjs --project examples/dilution-validation report
```

Restart the app with `--mode correct`, then repeat only `run` (using the label
`dilution-correct`) and `report`. Restart before every run: procedures create fixed
synthetic IDs and require an empty register. Generated files in this example are
ignored by Git.

## Test AI authoring

The [requirements](../dilution-validation/urs.yaml) and
[independent reference calculations](../dilution-validation/references/calculation-examples.csv)
specify intended behavior without exposing the defect switches. Use a fresh project
to test whether a provider can author useful procedures from them:

```sh
mkdir -p .demo-results/dilution-ai
cp examples/dilution-validation/urs.yaml .demo-results/dilution-ai/
cp -R examples/dilution-validation/references .demo-results/dilution-ai/
node bin/provenarium.mjs --project .demo-results/dilution-ai generate \
  --urs urs.yaml --url http://127.0.0.1:4174 \
  --provider openai --thoroughness standard --interactive-discovery
```

Use `--provider anthropic` to test the other provider. This command requires a
provider key and can incur API charges under the displayed spending ceiling. It
has not been run as part of this example's offline verification. For a blind
challenge, do not supply `plan.json`, application source, or the defect guide as
authoring context. Review the generated procedures and expectations, restart the
app to clear discovery records, then use `approve`, `run`, and `report` against
that project. A screenshot or observed application value alone is not a calculation
oracle: expected values must come from the requirements and independent arithmetic.

## Maintainer information

The [defect guide](DEFECTS.md) contains spoilers and known failure examples.
The server uses Node's built-in HTTP APIs and adds no runtime dependencies.
`GET /health`, `GET/POST /api/plans`, and `GET /export.csv` provide observable
interfaces alongside browser forms. Hosted test workspaces use `/w/<id>/` and
have a scoped **Clear preparations** control; clearing one never affects another.
The unscoped local comparison harness resets through its in-process test API.
