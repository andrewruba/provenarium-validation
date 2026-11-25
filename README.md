# Provenarium Validation

A command-line tool project for software validation in pharma and other GxP
workflows, centered on user requirements, readable protocols, and test evidence.

## Design

The intended workflow turns a User Requirements Specification (URS) into a
human-readable Installation and Operational Qualification (IOQ) protocol and
reviewable, deterministic Playwright tests.

```text
provenarium urs template
provenarium urs generate
provenarium context add app ../my-app
provenarium context add design ./design.docx
provenarium generate --urs urs.yaml --url https://app.example.com
provenarium approve
provenarium run
provenarium report
```

The CLI design includes:

- Blank, AI-assisted, or human-authored YAML requirements, informed by linked
  source code, design documents, and other context.
- AI-assisted IOQ and test authoring, followed by approval that freezes files
  by hash. Execution and reporting use fixed procedures without model calls.
- Guided terminal prompts for the user's provider API key and the application
  accounts needed for positive and negative access tests. Secrets stay out of
  requirements, generated tests, and reports.
- An executed record, screenshots and other evidence, and a requirements
  traceability matrix.

Users supply context appropriate to the deployed application. Hashes identify
inputs and artifacts; the tool does not verify source-to-deployment alignment.
Validation decisions remain with the organization responsible for intended use.

## Installation and use

The CLI implementation is available in this repository. Use Node.js 26 on macOS
or Linux:

```sh
npm ci
npm run build
node bin/provenarium.mjs browser install
node bin/provenarium.mjs --help
```

Start with `urs template`, or use `urs generate` with your selected provider.
OpenAI and Anthropic authoring offer Quick ($5), Standard ($15), and Thorough
($40) default spending ceilings per command. Approval, execution, and reporting
make no provider calls.

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
verify adapters and spending controls without paid calls. No package has been
published. See [release notes](CHANGELOG.md) for the implementation boundary.

## Scientific validation sandbox

[Dilution Bench](examples/dilution-app/README.md) is a standard laboratory dilution
planner with unit conversion, retained preparations, CSV export, and four deliberate
defects. It includes independent requirements, reference calculations, and a
prepared validation protocol.

```sh
npm run demo:dilution       # Open http://127.0.0.1:4174; deliberately faulty by default
npm run validate:dilution   # Compare faulty and corrected modes using one approval
```

The comparison retains reports and evidence locally and makes no provider calls.
You can also use the supplied requirements to test AI authoring against the app.

For online demos, the [deployment guide](docs/deployment.md) configures two free
Render services that deploy from `main` after GitHub Actions passes. The
[hosted CLI testing guide](docs/testing-hosted-dilution.md) covers prepared-protocol
and AI-authoring workflows, isolated test data, expected failures, and reports.

```sh
npm run validate:dilution:hosted -- \
  --correct-url https://YOUR-CORRECT-SERVICE.onrender.com \
  --faulty-url https://YOUR-FAULTY-SERVICE.onrender.com
```

Use the actual service URLs after the one-time Render setup. The **Hosted dilution
validation** Actions workflow runs the same comparison and retains its evidence.
