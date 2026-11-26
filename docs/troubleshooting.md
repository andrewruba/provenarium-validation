# Troubleshooting

## A blank URS does not pass readiness checks

The blank template intentionally contains no invented obligations. To have AI
draft requirements, run `provenarium urs` and supply context and the deployed URL.
An existing blank template is preserved while the draft gets a separate revision
filename. Use the printed filename for review and subsequent commands. If you
prefer manual writing, fill in intended use, meaningful requirement families,
and requirements yourself. Resolve placeholders and open questions before
protocol approval. An offline structural check cannot establish scientific
adequacy.

## I answered a question, but it still blocks readiness

An answer in YAML records a decision; the linked requirement must still be
updated or acknowledged. Run `provenarium urs resolve urs.yaml` to review the
proposed requirement changes, then accept the correct changes. Keep the answered
question in the file. Applied answers stop blocking readiness; editing the
answer, question, or linked requirement ID makes them pending again.

`urs resolve` prepares recommendations and requirement changes together, then
shows one accept/edit review. A specific unresolved item can remain pending while
you accept independent ready changes. It does not automatically ask every
question again.

An older failure saying a question "cannot be both resolved and unresolved" is a
generator contradiction, not evidence that your selected answer was lost. New
proposal requests give every pending question one outcome and can correct an
invalid proposal within the command's bounded repair allowance. Your saved
answers are reused when you rerun `urs resolve`; `check` cannot apply them. After
a proposal failure the CLI now directs you back to requirement review, while a
declined review points to its saved `--apply` command without another AI request.
When all questions are resolved, continue with the printed `generate --urs`
command. A separate `urs check` step is optional.

Use `urs resolve --question Q-CSV-01` to revise an existing answer in the terminal.
Use `--answers-only` to collect answers without a provider call, then return to
`urs resolve` when ready to review requirement changes. Ctrl+C retains answers
already submitted.

## I do not want to type every answer

Run `provenarium urs resolve urs.yaml`. It reads the linked source and saved
deployed URL, then prepares concrete recommendations for one accept/edit review.
Recommendations identify documented behavior, implementation observations, and
proposed defaults. “Choose something reasonable” asks for a proposed default;
it is not repeatedly returned as an unanswered questionnaire. Concrete recorded
answers are preserved. Local HTML source includes bounded JavaScript companions,
so relevant parsing, storage, and export behavior is available to authoring.

Recommendation and requirement-proposal requests share the command's spending
cap. `--yes` prepares and saves the review but does not accept unseen changes.
If consequential information is still missing, its specific blocker stays in the
review for you to edit or defer. `--answers-only` uses typed input and makes no
provider request.

## A CLI-generated URS has malformed references

Older drafts could put test identifiers or descriptive page observations in
`references`, where checks expect normative file paths. This was a generation
defect, not a missing answer. New generation separates provenance into
`citations` and runs structural checks before publishing a working draft.

For an existing file, run:

```sh
provenarium urs check urs.yaml --fix-references
```

The command uses linked source material and the saved deployed URL to identify
supported repairs. Review the proposed changes before confirming. It makes no
AI request and retains before/after snapshots under
`.provenarium/reference-repairs/`. It may read linked HTTPS context. Unsupported
repairs and genuinely missing normative files remain errors; do not delete those
references merely to obtain a passing check.

## A resolution proposal was saved but not applied

Fresh proposed requirement changes need review even when authoring was invoked
with `--yes`. Review the printed `.diff.txt` file and use
`provenarium urs resolve urs.yaml --apply <proposal-file>` to reopen the saved
proposal without a new AI call. After prior review, `--apply <proposal-file>
--yes` applies that saved artifact explicitly.

If a request failed while updating an edited review, follow the printed
`--resume <draft-file>` command instead. It restores the retained answers and
edits, then prepares a new proposal with a new command spending ceiling. The
working YAML is unchanged until you accept a completed review.

If the URS changed since the proposal was created, the saved proposal is stale.
Run `urs resolve` again to generate a proposal against the current file. The
command refuses to edit candidates, approved packages, and resolution-history
files; work on the editable URS in the selected validation project.

## All questions are resolved, but the URS still fails checks

Read the remaining `urs check` messages. For misplaced provenance in an older
generated draft, use `--fix-references` as described above. Genuine missing files,
placeholders, duplicate IDs, and other structural issues are separate from
question resolution. Correct those issues in the working requirements, then check again.
Refresh existing HTML/PDF views with `provenarium urs render urs.yaml` after edits.

## An IOQ asks for deployment evidence or test environments before approval

Rerun generation with the current CLI after accepting the requirements review.
Accepted delegated choices now carry their concrete policy and provenance into
test authoring. The tool should use those choices instead of asking you to
approve the same policy again or attach a separate decision after execution.

Newly generated protocols default to automated cases. Disposable persistent
profiles, tabs, restarts, confirmation dialogs, storage-denial checks, and CSV
inspection run in the browser test engine. Discovery automatically records
exact matches between linked JavaScript and deployed scripts; it does not ask
you to establish a match already supported by those hashes. Different script
bytes do not establish correspondence or justify invented product requirements.

A real missing acceptance criterion remains a blocker. A manual procedure is
allowed only with `generate --allow-manual` and a cited requirement that explicitly
requires human work or names the necessary external dependency. Its setup may
then appear under **Manual test setup**, and execution still reports
`manual_pending` until the work is completed. Do not delete requirements or
weaken expected results to remove a blocker. A test exposing an application
defect should continue to fail.

## Protocol generation stops on “Duplicate plan ID 01”

Older versions required step IDs to be unique across the entire protocol, even
though execution, evidence, and reports identify a step by its case and step ID.
Numbering each case from `01` therefore triggered a correction that could not
rename the protected IDs. Updated validation accepts repeated step numbers in
different cases, and scoped edits use the same case-and-step identity. Duplicate
steps within one case are still rejected, as are duplicate assertion, evidence,
case, actor, obligation, or question IDs across the plan.

After updating the CLI, rerun `generate --urs` with the same requirements and URL.
The retained failed draft is not automatically approved or published.

## Protocol generation reports invalid source bindings or opens a document title as a file

Older protocol generation could emit bare labels such as `statement` or
`details[0]` where a requirement binding was needed, then ask the user to explain
the runtime grammar. It could also put descriptive text in `plan.references`
and try to open that text as a filename. These are generation defects, not
missing user requirements.

Updated generation supplies exact bindings and the public anonymous-access
contract, normalizes equivalent source notation, and validates every response
and package input before publishing a candidate. It can make at most two
technical correction requests under the original command budget. If correction
fails, the incomplete authoring record and diagnostics are retained; the CLI
does not ask you to approve invalid runtime syntax or proceed to a filename
error.

Keep the printed authoring record when reporting a failure. After updating the
CLI, rerun `generate --urs` with the reviewed requirements and target URL. The
old record is retained and is not automatically promoted to a candidate.
Do not remove genuine normative files or weaken acceptance criteria just to
obtain a candidate.

## The generated protocol still has questions after the URS was resolved

Protocol design can expose a specific ambiguity or missing independent expected
value that the requirements draft did not identify. Review those questions
against the accepted requirements and supplied evidence. Tool syntax,
obligation binding grammar, and supported actor modes are internal authoring
responsibilities; they should not become user decisions.

A valid protocol may fail against the application when accepted requirements
describe behavior the implementation does not provide. Keep those failures as
evidence. Change the application or deliberately revise the intended requirement;
do not change the expected result merely to match an observed output.

## Provider request returned HTTP 400

HTTP 400 means the provider rejected the API request. Updated versions display
the provider's error message, type/code, rejected parameter, and request ID when
available. These bounded, redacted details are retained under `diagnostics` with
`kind: provider_http` in the authoring record. Raw error bodies and request
content are not copied into these diagnostics. HTTP errors are not retried.

Older versions discarded these details, so a record containing only the HTTP
status cannot establish the original rejection reason. Update the CLI and rerun
the command to capture that reason if rejection continues. An uncertain budget
reservation is a conservative allowance, not a confirmed usage charge.

## Provider output failed local schema validation

Current authoring supplies the actual document schema to the provider's native
structured-output API. Earlier versions constrained only a `payload` string and
validated the document encoded inside it afterward. Local validation remains
necessary for requirement links, expected-value protection, and other rules
that structural schemas cannot establish.

Older versions discarded the rejected response and its field-level errors before
the protocol correction loop could inspect them. A retained record containing
only that generic message cannot reveal which field failed; the original output
cannot be recovered from that record.

Updated generation records redacted, bounded rejected output and precise field
paths and error codes under `diagnostics` in the authoring JSON. Malformed JSON
or schema-invalid documents can be corrected using the same maximum of two
technical corrections for the entire command, within the original spending cap.
If correction fails or the cap cannot fund it, the attempt remains incomplete
and no candidate is published. Rejected content is never executed or silently
accepted by weakening the schema.

Update the CLI and rerun the original generation command. If the problem recurs,
retain the printed authoring record: it now includes the operation and actual
validation details needed to investigate. Refusals, incomplete provider output,
and uncertain network failures do not trigger automatic schema retries.

## A correction changed or removed an expected result

Protocol revisions now return typed edits rather than replacement documents.
Unchanged assertions, manual expected text, IDs, and requirement links are kept
by the application, rather than copied back by the model. The edit vocabulary
does not permit deleting existing checks or rewriting protected expectations.
Unsupported edits are rejected atomically and retained in diagnostics.

Older generation could author a regex under `matches`, whose runtime supports
only literal text and `*` wildcards. A long pattern then failed validation, but
the correction was blocked because the invalid initial draft was treated as an
accepted expectation. Short regex patterns could pass the old length check while
still having the wrong runtime meaning.

Updated authoring diagnoses these unsupported predicates and permits a scoped
correction to the invalid draft assertion. `csv_equals` checks complete decoded
CSV rows, and `contains_any` expresses finite literal text alternatives. Valid
assertions and existing reviewed expectations remain protected; the tool cannot
repair a format error by dropping checks or weakening an accepted result.

A rejected correction now retains the changed assertion IDs and before/proposed
values, and can use the remaining allowance within the same two-correction limit
and spending cap. Proposed corrections to invalid draft assertions are also
retained for protocol review. A historical record with only the original plan
and generic error cannot reveal the exact replacement that was rejected.

Update the CLI and rerun generation. Do not change an intended requirement just
to accommodate a malformed generated predicate. If a correction remains blocked,
inspect the printed authoring record's `diagnostics` for the specific protected
expectation or coverage change.

## An answered IOQ question still blocks approval

For a question raised in the IOQ, put its exact ID and answer in the revision
feedback, such as `IOQ-Q-01: Use the installed Chromium browser.` Rerun
`provenarium generate --urs urs.yaml --feedback feedback.md` and review the new
candidate. The original question, supporting quote, and resolution remain in
the authoring record's diagnostics after the active blocker is removed.
Autonomous review cannot dismiss questions. If your answer changes intended
application behavior or an expected result, first update and review the URS
revision; feedback alone cannot authorize that change.

## The CLI reports missing Chromium

Install the browser using the setup command printed by the installed CLI. Browser files are version-specific. Linux may also need system libraries. Execution and report generation never install dependencies automatically.

## A linked document is unreadable or only partly extracted

Inspect the source warning and provide a readable local export or a text-bearing document. Scanned PDFs require an external transcription/OCR process. Unsupported content is not silently treated as complete. Sources are read-only; the tool does not build linked source repositories or execute their scripts.

## Authoring stops at its spending ceiling

The command retains its incomplete draft and unresolved work. Quick, Standard, and Thorough default to $5, $15, and $40 respectively per authoring command. A higher tier changes investigation and review depth; it does not guarantee completeness. A custom `--max-spend` ceiling does not silently change the selected tier. Start a new explicitly budgeted revision to continue.

## A provider request fails or a model is unsupported

Check the selected provider/model and the provider's account access. Only supported models with known pricing bounds may dispatch paid calls. The CLI does not switch providers, silently retry billed requests, or increase the ceiling. A request with uncertain billing retains its full reservation.

## No secure credential store is available

Use session-only masked entry. On Linux, persistent storage needs a working, unlocked Secret Service. The CLI must never fall back to a plaintext credential file. Do not put passwords in YAML, command arguments, test code, or reports.

## Authentication preparation or login fails

Check the named actor's required role, account state, organization, and purpose. A disabled-account test does not need a successful setup login. An incorrect-password test uses a known active username with a deliberately incorrect password. A saved session must not replace an actual login test. After qualification starts, unexpected login rejection is a retained failure; the runner does not substitute another account to obtain a pass.

## An approved file has changed

Restore the exact approved file or revise the candidate and obtain a new approval. Do not edit the checksum record to bypass the change check. Procedure and expectation changes belong in the candidate plan or URS, followed by regenerated documents and tests.

## A case is blocked, unexecuted, or manually pending

Read its case/step observation and prerequisites. `manual_pending` identifies planned work outside automated execution. Missing required evidence prevents a completed passing case. Interruption retains earlier evidence and leaves the run incomplete. A retest creates a new run and preserves the original result.

## A report identifies changed or missing evidence

Restore evidence from an independently retained copy if available, or retain the discrepancy for review. Reporting never revisits the application to recreate evidence for an earlier run. Local hashes detect changes relative to local records; they are not regulated signatures or tamper-proof archival storage.

## The synthetic example fails on a repeated run

The reviewed example declares an empty starting data directory. Restart the sample application with a new empty directory before repeating the demonstration. Keep the approved package unchanged when comparing the good and deliberately defective variants at the same URL. The defective variant intentionally permits duplicate identifiers; its duplicate-prevention case should fail.
