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

Before publishing the working YAML, the CLI separates source provenance from
normative file references and runs the same structural checks used by `urs check`.
Specific unresolved human decisions may remain in a draft. Malformed references,
duplicate IDs, inconsistent tables, and other structural defects prevent the
working draft from being published; the attempted output and diagnostics remain
in the authoring record for investigation.

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

Plain `check` performs local validation without provider calls. `--review` adds
paid AI review. `--fix-references` can read linked context, including HTTPS
sources, to propose evidence-backed repairs without a provider call. Structural
checks help identify missing information; the author still reviews what the
requirements say.

For an older draft whose generated references contain observation descriptions
or test identifiers instead of filenames:

```sh
provenarium urs check urs.yaml --fix-references
```

The command shows the reference-to-citation changes and asks before applying
them. Use `--yes` only to apply those repairs without an interactive prompt.
Repairs require supporting linked context or the saved deployed URL and preserve
before/after snapshots under `.provenarium/reference-repairs/`. A real missing
normative file is still an error; this command does not discard evidence
requirements to make checks pass. Rerun `check` after resolving any remaining
questions or missing inputs.

Once the URS is reviewed, create the IOQ protocol and tests:

```sh
provenarium generate --urs urs.yaml --url https://app.example.com
```

## Answer and resolve requirements questions

```sh
provenarium urs resolve urs.yaml
```

The filename defaults to `urs.yaml`. In an interactive terminal, the command
reads the selected linked context and inspects the saved deployed URL without
form interactions. After one provider/spending preview, it requests one batch
of answer suggestions. Each question shows a suggested answer, its supporting
source, and a short explanation. Accept it, edit it, choose a concrete
alternative, or skip the question. Ctrl+C stops while retaining answers already
submitted.

Suggestions distinguish documented intended behavior from current implementation
behavior. A missing product decision gets alternatives rather than an invented
default. Accepting a suggestion records your intended decision; it does not yet
apply requirement changes. Questions with recorded answers are skipped and those
answers are reused. To revisit an answer, use `--question Q-CSV-01`; repeat
`--question` for additional IDs.

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

After answers are recorded, the command makes one targeted requirement-change
proposal. You can select `--provider`, `--model`, `--source`, and `--max-spend`.
The suggestion batch and proposal share one command spending ceiling and one
provider preview; there is no separate budget per question. If all answers are
already recorded, only the proposal request is needed. The saved/default ceiling
applies unless `--max-spend` overrides it; there is no thoroughness selection or
repeated review loop for resolution.
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

To type answers without suggestions, a provider request, or requirement edits:

```sh
provenarium urs resolve urs.yaml --answers-only
```

This offline mode shows the question and related requirement, accepts a typed
answer, and lets Enter skip a question. Previously submitted answers are saved
when you stop.

Suggestion batches are retained as `.suggestions.json`; requirement reviews are
retained as `.diff.txt` and `.proposal.json` under `.provenarium/resolutions/`.
The CLI prints their paths. To return to a saved
proposal without another AI request, use its printed path:

```sh
provenarium urs resolve urs.yaml --apply .provenarium/resolutions/REVIEW_ID.proposal.json
```

The proposal must match the current source file; changing the YAML after proposal
creation requires a fresh proposal. `--yes` on a new resolution request accepts
authoring consent; it never accepts suggested answers or fresh requirement
changes. For scripted use, record answers in YAML first. Without an interactive
terminal, the proposal is retained for later review. After reviewing a saved proposal, `--apply ...
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

## Protocol generation checks

`generate --urs` supplies the authoring model with the supported runtime contract
and exact source bindings for the supplied requirements. Every initial and
revised response is checked for structural validity and readable package inputs
before a candidate is created. A requirement clause label or document title is
not a filename. The URS is already included in the package; plan references may
name only existing normative files declared by that URS or generated text
fixtures. Required normative files are listed in the data-sharing preview and
included as bounded context excerpts.

Unambiguous equivalent source notation is normalized locally. Other technical
defects can trigger at most two correction requests across the entire command,
including discovery, drafting, and review rounds. Malformed provider JSON and
documents that fail the local schema use this same two-correction allowance;
they do not receive a separate retry budget. These requests share the original
spending cap.
Corrections must preserve cases, requirement coverage, and expected results;
they cannot make a failing format check disappear by converting automated cases
to manual work. If errors remain or the budget cannot cover a correction, the
authoring record retains the incomplete attempt and diagnostics, and no
candidate is published.

The authoring record's `diagnostics` list retains the operation, validation
paths and error codes, and bounded, redacted rejected output. This is untrusted
diagnostic material, not a validated plan. Schema correction reuses the supplied
requirements and runtime contract and does not execute the rejected content.
Network failures, refusals, and provider-declared incomplete output are not
automatically retried as schema corrections.

Runtime syntax and tool-format questions belong to those technical diagnostics,
not to the user's requirements decisions. Genuine uncertainties about intended
behavior, independent expected values, or required evidence remain explicit
questions and block approval. A structurally valid candidate still needs human
review before execution.

Read-only discovery limits what the authoring session does to the application.
It does not prevent authoring automated fill, click, calculation, or download
tests for later approved execution. Manual procedures are appropriate for
operations the supported execution vocabulary cannot perform.

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

An obligation's `source` identifies actual text or a table in the linked
requirement. Canonical examples are `URS-INPUT-01/statement`,
`URS-INPUT-01/details/0`, and `URS-INPUT-01/table`. An absolute JSON pointer such
as `/families/0/requirements/0/statement` is also supported when it resolves to
the same requirement. The generator receives these bindings with their source
content; users do not need to determine the grammar. Metadata such as titles,
IDs, or applicability flags cannot establish a test obligation.

For a public application without login, an access declaration with
`state: signed_out` and `mode: anonymous` is valid. Reusable session access uses
`mode: session` with `state: active`.

Unrestricted JavaScript, shell commands, generalized expressions, and arbitrary
imports are rejected. Unsupported behavior needs an explicit manual procedure.
Text-bearing context extraction is bounded; warnings identify incomplete reads.
Screenshots mask known secret controls and refuse detected unsafe captures.
Arbitrary secrets painted into image/canvas content cannot be reliably identified;
use suitable synthetic test data and structured observations for such journeys.
