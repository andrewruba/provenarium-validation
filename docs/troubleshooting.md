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

Use `urs resolve --question Q-CSV-01` to revise an existing answer in the terminal.
Use `--answers-only` to collect answers without a provider call, then return to
`urs resolve` when ready to review requirement changes. Ctrl+C retains answers
already submitted.

## I do not want to type every answer

Run `provenarium urs resolve urs.yaml` in an interactive terminal. It reads the
linked context and saved deployed URL, then offers sourced suggestions to accept
or edit. Where the material does not establish an answer, it offers concrete
alternatives instead of choosing a policy for you. Already recorded answers are
reused. `--answers-only` deliberately uses typed input and makes no provider
request; omit that flag to get AI suggestions.

Suggestion and requirement-proposal requests share the command's spending cap.
`--yes` does not accept suggested answers. If no supported suggestion is
available, review the context warnings, enter a specific decision, or skip.

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
