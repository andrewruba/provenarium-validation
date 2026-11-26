# CLI workflow

The CLI owns ordinary local files. `--project <directory>` selects the validation
project; file inputs resolve relative to that project, and output paths stay
within it. No project initialization command is required.

## Requirements

Start with the guided command:

```sh
provenarium urs
```

Supply context locations and the deployed application URL. The CLI reads the
source code or documents, inspects the application, and drafts requirements after
the provider and spending preview. It does not ask a general intended-use
interview. Specific unresolved decisions are recorded in the draft's
`open_questions`, so review starts from concrete requirements and gaps.

To supply the inputs directly:

```sh
provenarium urs generate --context ../application --context ./design.docx \
  --url https://app.example.com
# Answer questions and review requirement changes:
provenarium urs resolve urs.yaml
# Review the resulting URS before continuing:
provenarium urs check urs.yaml
```

Repeat `--context` for each source folder, document, or HTTPS page. No source IDs
are required; links are saved for later authoring. Previously linked sources are
also available. `--brief brief.md` optionally adds written guidance, such as a
particular use case or scope restriction; a brief is not required.

`urs generate` writes a draft URS; it does not create qualification tests.
The model is instructed to use supplied evidence first and retain only specific
material questions that the sources do not answer. For example, a missing
rounding rule should name the affected calculation or export field. Observed
application behavior does not establish an acceptance limit or independent
expected result.

The draft is written to `urs.yaml` by default, with HTML/PDF views. `--out` changes
the YAML output path; `--no-pdf` skips PDF rendering. If the output file already
exists, it informs the draft and the new revision gets a separate filename
automatically. An untouched blank template can be filled by AI while the
original file is preserved. Follow the printed filename in subsequent commands.

To write the requirements yourself, use this route instead:

```sh
provenarium urs template --out urs.yaml
# Fill in intended use and requirements in urs.yaml:
provenarium urs check urs.yaml
```

The template contains writing prompts and needs editing before it can be used.
Run `provenarium urs` if you want AI to draft or revise requirements instead. If you
already have a URS in the supported YAML format, start with `urs check` directly.

Optional review and document views are available separately:

```sh
provenarium urs render urs.yaml
provenarium urs check urs.yaml --review
```

`check` is offline unless `--review` is explicitly selected. Structural checks
help identify missing information; the author still reviews what the
requirements say.

Once the URS is reviewed, create the IOQ protocol and tests:

```sh
provenarium generate --urs urs.yaml --url https://app.example.com
```

## Answer and resolve requirements questions

```sh
provenarium urs resolve urs.yaml
```

The filename defaults to `urs.yaml`. In an interactive terminal, the command
shows each unanswered question and its related requirement. Enter your decision,
press Enter to skip, or press Ctrl+C to stop while retaining answers already
submitted. Questions with recorded answers are skipped. To revise one of those
answers, use `--question Q-CSV-01`; repeat `--question` for additional IDs.

You can also edit answers directly beside the questions:

```yaml
open_questions:
  - id: Q-CSV-01
    requirement: URS-CSV-01
    question: What should an empty CSV export contain?
    answer: "Column headings only, with no data rows."
```

New drafts include `answer: null`; older files without the field still work.
Blank or null answers remain unanswered. Recording an answer does not yet change
the requirement or remove its readiness blocker. Run `urs resolve` to review
how the answer should be incorporated.

With pending answers, the command uses the selected provider to make one targeted
proposal. You can select `--provider`, `--model`, `--source`, and `--max-spend`;
the command previews the provider, selected material, and spending ceiling.
It uses the saved/default spending ceiling unless `--max-spend` overrides it;
there is no thoroughness selection or repeated review loop for resolution.
The CLI displays the exact questions and answers, complete before/after
requirement text, reasons for each change, and the proposed document revision.
Accept only changes that express your intended decisions. A requirement that
already expresses an answer is shown for acknowledgment without a text change.
Ambiguous answers remain pending with a specific explanation.

After acceptance, the working URS is updated, its revision advances, and questions
remain beside their answers and application records. Applied answers stop
blocking readiness. Changing the answer, question, or linked requirement ID
requires another resolution review. Do not delete answered questions or manually
set resolution metadata to bypass that review.

To collect answers without a provider request or requirement edits:

```sh
provenarium urs resolve urs.yaml --answers-only
```

Reviews are retained as `.diff.txt` and `.proposal.json` files under
`.provenarium/resolutions/`. The CLI prints their paths. To return to a saved
proposal without another AI request, use its printed path:

```sh
provenarium urs resolve urs.yaml --apply .provenarium/resolutions/REVIEW_ID.proposal.json
```

The proposal must match the current source file; changing the YAML after proposal
creation requires a fresh proposal. `--yes` on a new resolution request accepts
authoring consent but still requires interactive confirmation before fresh
requirement changes are applied. Without an interactive terminal, the proposal
is retained for later review. After reviewing a saved proposal, `--apply ...
--yes` explicitly applies that saved artifact without a prompt. The offline
`--apply` and `--answers-only` modes do not accept authoring options.

Before/after copies of applied requirement changes are retained under
`.provenarium/resolutions/`, along with earlier copies made when recording
answers. These local records support review and traceability; they do not certify
the identity of the person who approved a decision. The command edits only a
working URS inside the selected `--project` directory, not generated candidates,
approved packages, or history files.

Finish by checking the complete URS and refreshing its document views:

```sh
provenarium urs check urs.yaml
provenarium urs render urs.yaml
```

Resolving questions does not clear unrelated errors such as missing reference
files or unresolved placeholders. `urs render --no-pdf` refreshes HTML without
Chromium PDF rendering.

## Context and paid authoring

```sh
provenarium context add app ../application
provenarium context add design ./design.docx
provenarium context list
```

These commands are optional tools for managing existing context links. Normal
setup accepts locations directly, and `urs generate --context <location>` adds
them without asking for names. Links persist in the validation project. Adding
a link alone does not draft or change requirements. Both `urs generate` and
`generate --urs` use linked sources by default. You do not need to add the same
sources again for protocol generation. `context list` shows their IDs, and
`context remove <id>` removes a link.

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

Interactive drafting, requirements review, and protocol generation ask you to
choose a thoroughness level before the spending confirmation, with the saved
level (or Standard on first use) preselected. Each
option shows its maximum spend for this command. To choose up front, use
`--thoroughness quick|standard|thorough` on `urs generate`, `generate`, or
`urs check --review`. An explicit level skips the selector. Scripted `--yes`
also skips it, using the explicit, saved, or default level in that order.

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

## Uninstall

`provenarium uninstall --dry-run` displays the verified npm global installation
and removal command. `provenarium uninstall` asks for confirmation;
`provenarium uninstall --yes` explicitly authorizes unattended removal. The
command delegates to npm with the verified prefix and refuses local installs,
source checkouts, linked packages, and mismatched npm installations. It preserves
validation projects, retained evidence, credentials, and shared browser files.
See the [installation guide](installation.md#uninstall) for manual removal and
optional credential cleanup before uninstalling.

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
