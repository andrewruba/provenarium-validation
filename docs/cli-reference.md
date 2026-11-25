# CLI workflow

The CLI owns ordinary local files. `--project <directory>` selects the validation
project; file inputs resolve relative to that project, and output paths stay
within it. No project initialization command is required.

## Requirements

```sh
provenarium urs template --out urs.yaml
provenarium urs check urs.yaml
provenarium urs render urs.yaml
provenarium urs generate --brief brief.md --detail detailed
provenarium urs check urs.yaml --review
```

`urs` without a subcommand offers a guided choice. The blank template contains
writing prompts but no invented obligations. Review and rendering are separate:
`check` is offline unless `--review` is explicitly selected. Existing requirement
files are preserved; generated revisions receive separate filenames.

## Context and paid authoring

```sh
provenarium context add app ../application
provenarium context add design ./design.docx
provenarium context list
provenarium generate --urs urs.yaml --url http://localhost:4173 \
  --provider openai --thoroughness standard --interactive-discovery
```

Both `openai` and `anthropic` are supported. The first paid command previews the
provider, model, selected sources, and spending ceiling, then requests a masked
API key. `--source app design` limits linked context. `--yes` accepts the displayed
preview for scripted use; it never supplies credentials or raises the ceiling.
`auth --provider <provider>` stores a key only in the OS credential store;
`auth forget --provider <provider>` removes it.

| Thoroughness | Default maximum per command | Work |
| --- | ---: | --- |
| quick | $5 | Initial discovery/draft and focused review |
| standard | $15 | Additional boundary, access, persistence, and export review |
| thorough | $40 | Additional adversarial and consequential-combination review |

`--max-spend <USD>` overrides only the ceiling. `--model` selects a model from the
verified catalog. Models do not switch automatically between tiers. `--detail`
controls requirements elaboration independently. Actual effort, estimated usage,
uncertain reservations, and unfinished work are retained under `drafts/`. Provider
invoices may differ from estimates; the CLI conservatively reserves each request
against its verified pricing assumptions. Incomplete work is never presented as
an approved protocol.

Discovery uses read-only navigation by default. `--interactive-discovery`
authorizes browser form interactions within the target origin using synthetic
data. Protected applications can use `--access access.json`, a non-secret JSON
array matching the documented access inventory, and `--discovery-actor <id>` to
choose among multiple prepared sessions. Credentials never belong in this file.
`--rehearse` authorizes candidate procedures as authoring diagnostics, separately
from qualification runs. Rehearsal results identify the exact plan hash; a revised
plan needs another rehearsal to establish new diagnostics.

Generation preserves the URS. Subsequent generation asks for revision feedback,
or accepts `--feedback feedback.md`. Expected outcomes remain frozen unless a
reviewed URS revision changes the corresponding normative requirements.

## Offline reviewed-plan route

Developers and reviewers can compile an existing typed plan without a provider:

```sh
provenarium --project ./examples/sample-validation generate --urs urs.yaml --plan plan.json
```

This is an optional developer interface, not a format requirements authors need
to learn. It accepts no authoring or target-override flags. Edit the plan and
regenerate to change procedures; never edit generated executable tests.

## Review, execution, and reporting

```sh
provenarium approve
provenarium run
provenarium report
```

Each candidate has a readable IOQ, compiled tests, fixtures, a clause-coverage
view, and `changes.json`. Approval displays the selected candidate and changes;
`approve --yes` explicitly confirms prior review for scripted workflows. Missing
expectations, unresolved questions, missing inputs, and uncovered applicable
requirements block approval. The reviewer remains responsible for semantic
coverage and the adequacy of independent expected values.

Run verifies hashes before requesting application credentials. It collects all
bindings, executes only approved tests, and retains observations and evidence
under a new run ID. `--package` chooses an explicit approval; `--release-label`
records a user-supplied label without asserting source/deployment alignment.
Runs with failures, blocked/unexecuted cases, or pending manual work return a
nonzero CLI exit status. Manual cases remain pending; local bookkeeping completion
does not mean organizational acceptance.

`report --run <id>` renders retained results without revisiting the application.
`report --package <id>` renders an unexecuted approved protocol. Reports include
HTML/PDF and CSV traceability, verify evidence hashes, and expose incomplete or
damaged records. `--no-pdf` is available on rendering/generation/approval commands
for HTML-only workflows. Chromium setup is explicit: `provenarium browser install`.

## Supported execution vocabulary

Plans support navigation, declared sessions, filling/selecting/clicking, named
secret bindings, file upload/download, bounded HTTP checks, value/table reads,
explicit assertions, and required evidence. Text comparisons preserve exact
whitespace. `matches` supports literal text with `*` wildcards, not regular
expressions. Numeric comparisons require a declared expected number and tolerance.
Variable references identify preceding reads, HTTP responses, or downloads.

Unrestricted JavaScript, shell commands, generalized expressions, and arbitrary
imports are rejected. Unsupported behavior needs an explicit manual procedure.
Text-bearing context extraction is bounded; warnings identify incomplete reads.
Screenshots mask known secret controls and refuse detected unsafe captures.
Arbitrary secrets painted into image/canvas content cannot be reliably identified;
use suitable synthetic test data and structured observations for such journeys.
