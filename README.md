# Provenarium Validation

A command-line tool project for software validation in pharma and other GxP
workflows, centered on user requirements, readable protocols, and test evidence.

## Workflow

Start with your source code or design documents and the deployed application
URL. `provenarium urs` collects those inputs, shows the authoring cost and data
preview, and drafts a User Requirements Specification (URS): what the application
must do for its users. There is no preliminary interview. Review the draft and
resolve any specific missing decisions recorded as open questions.

```sh
provenarium urs
# Answer questions and review the proposed requirement changes:
provenarium urs resolve urs.yaml
# Review the resulting requirements, then check them:
provenarium urs check urs.yaml

# Turn the reviewed requirements into a protocol and tests:
provenarium generate --urs urs.yaml --url https://app.example.com
# Review the generated IOQ before approving:
provenarium approve
provenarium run
provenarium report
```

Use the requirements filename printed by setup. Existing files are preserved,
and a new revision receives a separate filename. `generate --urs` produces a
human-readable Installation and Operational Qualification (IOQ) protocol and
deterministic Playwright tests.

Protocol generation checks requirement links, actor declarations, and required
files before creating a candidate. It corrects unambiguous source notation and
can request up to two technical corrections under the same spending ceiling.
Uncorrected tool-format errors remain in an incomplete authoring record;
genuine product decisions and missing required evidence still need review.

`urs resolve` suggests answers from the linked context and deployed application.
For each question, review the suggestion and its source, then accept, edit, choose
an alternative, or skip. You can also edit the `answer` field beside each question
in YAML. The command shows proposed requirement changes before asking you to apply
them. Questions and accepted answers stay in the document for traceability.
Suggestion and requirement-proposal requests share one spending ceiling.
Use `urs resolve --answers-only` to type answers without an AI request.

Generated drafts are checked for structural defects before being written as a
working URS. Source observations belong in citations; file references must name
real supporting files. For older drafts with misplaced provenance, run
`urs check urs.yaml --fix-references` to review evidence-backed reference repairs
without a provider call. Genuine missing files remain readiness blockers.

You can supply the inputs directly instead of using prompts:

```sh
provenarium urs generate --context ../my-app --context ./design.docx \
  --url https://app.example.com
```

Manual writing and existing requirements remain available as alternatives:

| Starting point | Command | What you do next |
| --- | --- | --- |
| Write requirements yourself | `provenarium urs template` | Fill in the blank `urs.yaml`. |
| Already have requirements in the supported YAML format | `provenarium urs check urs.yaml` | Resolve any issues, then continue to `generate --urs`. |

Context added during setup is reused for later protocol generation. You do not
need to name each source or link it again. Optional `context` commands let you
inspect and manage those links. See the [CLI reference](docs/cli-reference.md)
for additional authoring options.

The CLI supports:

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

Start with `provenarium urs` for guided requirements setup.
OpenAI and Anthropic authoring offer Quick ($5), Standard ($15), and Thorough
($40) default spending ceilings per command. Draft and protocol authoring let you choose
the level before confirming the spend, with your last choice preselected.
Approval, execution, and reporting make no provider calls.

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
