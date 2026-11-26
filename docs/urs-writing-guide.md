# Writing useful requirements

The editable requirements authority is `urs.yaml`. HTML and PDF views are generated from that file. A requirement describes what a user needs the system to do; it does not need browser selectors, automation code, or a separate assertion language.

Start with `provenarium urs`, supply source code or documents and the deployed
application URL, and review the resulting draft. You do not need to describe the
application in a preliminary interview. The authoring step reads the material
first and records specific missing decisions as open questions.

You can provide the same inputs directly:

```sh
provenarium urs generate --context ../my-app --context ./design.docx \
  --url https://app.example.com
```

Repeat `--context` for additional sources. These links are reused when generating
the protocol. An optional `--brief brief.md` can narrow the scope or provide
guidance that is absent from the source material.

If you prefer to write from scratch, run `provenarium urs template --out
urs.yaml` and fill in the file. If you already have requirements in the supported
YAML format, start with `provenarium urs check` and that file's path.

Use `provenarium urs resolve urs.yaml` to answer questions and review the
corresponding requirement changes. Then run `provenarium urs check urs.yaml`.
Use the filename printed by setup if it generated a revision; existing files
are preserved. Resolve missing information before continuing:

```sh
provenarium generate --urs urs.yaml --url https://app.example.com
```

This command writes the IOQ protocol and tests from the reviewed requirements.
`urs generate` writes the requirements themselves. Both generated requirements
and generated protocols need human review before approval.

## Review the intended use and specific gaps

Check that the draft describes the people using the application, the process it
supports, decisions its outputs influence, and explicit exclusions. Confirm its
roles and inputs/outputs against the supplied material. For calculations, review
the independently justified method, example values, units, precision, and
tolerances.

Open questions should identify a concrete missing decision: for example,
"The CSV specification does not state the dilution-factor precision. How many
decimal places should that column retain?" Supply the missing fact or reference
as the answer. Do not invent an acceptance value merely to complete a draft.

Do not derive expected results by copying the application's current outputs. A correct test can fail against a defective application. A source-code observation is context, not automatic acceptance of its behavior.

## Answer questions and review the resulting requirements

Run `provenarium urs resolve urs.yaml` to work through unanswered questions in the
terminal. It reads the linked material and inspects the saved deployed URL, then
suggests concrete answers with their supporting sources. Accept a suggestion,
edit it, choose an alternative, or skip. Stop with Ctrl+C at any point; submitted
answers are retained. On a later run, already answered questions are skipped.
Use `--question Q-CSV-01` to revisit a particular answer.

Read the basis shown with each suggestion. A documented requirement can support
a proposed answer; source code and page observations describe implementation
behavior that still needs your confirmation. Genuine policy or scope choices
remain decisions for you, with concrete alternatives where possible. The tool
does not accept a model's suggestion on your behalf.

Alternatively, fill in the `answer` field directly in YAML:

```yaml
open_questions:
  - id: Q-CSV-01
    requirement: URS-CSV-01
    question: What should an empty CSV export contain?
    answer: "Column headings only, with no data rows."
```

Leave `answer: null` when the decision is still unknown. Keep the question and
its ID. Answers are decisions to incorporate, so an answered question still
needs review before it counts as resolved.

Run `urs resolve` after editing answers. It proposes targeted requirement changes
using one AI request, then shows the full
question, answer, and before/after text. Review the proposal for consistent
wording across every affected requirement and confirm whether to apply it. The
command also handles a decision already expressed by the existing requirement:
it shows the current text for acknowledgment. An ambiguous answer remains
pending rather than becoming an invented rule. When you use suggestions, their
batch request and the later proposal share one spending ceiling and one
provider/spending preview.

Accepted changes update the working YAML and advance its document revision.
Questions and answers stay in the file with resolution metadata, while review
artifacts and before/after copies are saved under `.provenarium/resolutions/`.
Changing an answer or its question reopens that decision for review. Keep the
metadata written by the CLI; do not delete answered questions to make checks
pass.

`urs resolve --answers-only` collects typed answers offline without suggestions.
Suggestion batches are retained as `.suggestions.json` in the resolution
history. You can also leave a
proposal unapplied and return to its printed path with `urs resolve --apply
<proposal-file>` without making another AI request. See the [CLI
reference](cli-reference.md#answer-and-resolve-requirements-questions) for scripted
use and saved-proposal checks.

After applying changes, run `urs check` and regenerate HTML/PDF views with
`urs render`. Review any remaining structural or reference-file errors before
protocol generation.

## Keep provenance separate from required files

Use `citations` to identify context sources and locations that informed a
requirement. Use `references` for actual normative files needed to establish its
expected results, such as an independent calculation worksheet. A test-case ID
or a sentence describing a page observation is not a filename.

Generated drafts undergo reference normalization and structural validation before
being published. A draft may still need human decisions, but the tool must not
publish malformed file references as a completed draft. For older generated
files, `urs check urs.yaml --fix-references` previews supported conversions from
misplaced provenance to citations and retains repair snapshots. Real missing
normative files remain errors and must be supplied.

## Make obligations observable

- Give every requirement a stable ID and one cohesive behavior.
- State who can do what, under which conditions, and what is displayed, retained, calculated, or rejected.
- Specify defaults separately from mandatory or editable values.
- Describe blank, malformed, invalid, and boundary inputs where relevant.
- Name table columns, units, row meaning, ordering, and relationships to inputs.
- State what remains after saving, reopening, exporting, or changing roles.
- Preserve uncertainty as an open question. Do not invent retention periods, permissions, or scientific expectations to complete a draft.
- Use non-applicability only with a reason grounded in intended use. Missing application functionality is not itself a reason to exclude a requirement.

For example:

```yaml
- id: URS-REC-002
  title: Duplicate receipt prevention
  statement: >-
    Saving an existing Sample ID shall be rejected with an explanation.
    Surrounding spaces shall be ignored and identifiers shall be case-sensitive.
    The original record shall remain unchanged and no second record shall be created.
```

Tables can hold field names, data types, choices, requiredness, defaults, and limits. Keep larger permission matrices or calculation examples in referenced files. Normative files needed by tests are copied into the approved package.

## Review the generated coverage

The generated test plan decomposes detailed requirements into readable clause groups. Each group references assertions or an explicit manual procedure. Review that decomposition alongside the original URS: structural checks can verify links but cannot prove semantic completeness.

Unknown expected behavior blocks approval. A fully specified manual procedure may remain planned and will appear as `manual_pending` in executed reports. Passing automated cases do not complete outstanding manual work.

`--detail concise` reduces URS elaboration. `--thoroughness quick|standard|thorough` controls paid authoring effort and relevant scenario breadth. All levels preserve the same approval requirements.

The [synthetic sample URS](../examples/sample-validation/urs.yaml) illustrates the format, including fields, independent calculation examples, negative access, exports, attachments, and external recovery evidence.
