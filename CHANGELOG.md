# Changelog

## Unreleased

- Added `validate` to draft and resolve requirements, obtain one approval of the
  URS, generate the IOQ and Playwright tests, and dry-run the browser procedures.
  On success it executes the frozen tests and renders the summary. On a dry run
  failure it saves the IOQ and diagnostics for the next attempt.
- Made protocol coverage review optional. `generate --review-coverage` requests
  one advisory review after local checks and any requested rehearsal. Findings
  and review errors are recorded for the human reviewer without editing or
  blocking the candidate. Browser rehearsal records failures directly.
- Added `generate --resume <draft-file>` to package verified completed
  conversions without a provider call. A normal matching retry can do the same
  automatically. Add `--rehearse` to test the recovered procedures before human
  approval.
- Converted manual cases one at a time, retaining each valid result without
  treating the remaining cases as technical failures. Growing plans use bounded
  case views for edits. Every edit is validated against the complete plan and
  existing expectations.
- Added automatic reuse of completed conversions when retrying a matching
  incomplete generation. Input fingerprints and strict edit replay reject stale
  work; legacy records require exact replay with unchanged inputs. The CLI prints
  the resumed count, and reused work still requires review and explicit approval.
- Removed duplicated prior plans and repeated requirement/decision/catalog text
  from protocol revision requests. Requests retain the complete URS, context,
  current candidate, and fixtures, with explicit references for repeated text.
  Local size failures now retain a byte breakdown and identify request assembly
  as the cause, without dispatching or reserving budget for that step.
- Persisted accepted delegated decisions with their authority, rationale, sources,
  and scope, and supplied them to subsequent protocol authoring. Default generation
  now requires automated coverage; manual exceptions require `--allow-manual` and
  an exact supporting requirement. Existing manual cases can be converted with
  typed, audited edits that transfer every obligation and retain expected results.
- Added trusted browser tabs, disposable persistent profiles and actual browser
  restarts, dialog decisions, storage denial, negative-download observation, and
  byte-level download metadata. Table snapshots wait for the table to appear.
  Source-script correspondence is checked automatically with exact byte hashes.
- Separated missing requirement decisions from preparation for defined manual
  tests. Protocols retain setup needs and linked cases without blocking approval;
  those cases remain `manual_pending`. Existing questions stay blocking unless
  explicitly reclassified, with before/after changes retained for review.
- Matched protocol step-ID validation to runtime identity: step numbers may repeat
  across test cases, while duplicates within one case remain invalid. Scoped edits
  and their audit records now consistently identify steps by case and step,
  preventing unnecessary authoring correction requests for valid numbering.
- Replaced the default question-by-question requirements interview with one
  consolidated recommendation and requirement-change review. Explicit delegation
  now produces labeled proposed defaults; concrete saved decisions are preserved.
  Acceptance applies answers and reviewed requirement changes together, with
  staged reviews retained for later offline application.
- Included actual local HTML source and bounded JavaScript companions in
  authoring context, with exact source locations, hashes, and extraction warnings.
- Made answer-resolution outcomes exclusive per question in the provider schema,
  with two bounded technical corrections shared across the command and retained
  diagnostics. A missing clarification can no longer mark an answer both resolved
  and unresolved or prevent independent answers from reaching review.
- Kept answer selection, requirement review, and focused clarification in the same
  CLI flow. Pending answers now point to the appropriate review/resume command;
  `urs check` is suggested after resolution is complete.
- Retained and displayed bounded, redacted provider HTTP error details and request
  IDs, so rejected API requests identify the failing parameter instead of only
  reporting a status code. HTTP failures remain excluded from automatic retries.
- Normalized described OpenAI schema references to inline typed definitions,
  matching the official Python SDK's strict-schema compatibility handling.
- Replaced the unconstrained JSON-string payload envelope with provider-native
  structured output for the actual typed document. Local validation remains the
  authority for semantic rules and execution readiness.
- Replaced whole-plan revisions with typed, scoped edits applied atomically by
  the CLI. Existing IDs, checks, coverage, and protected expectations remain
  unchanged. Unsupported edit proposals retain actionable diagnostics.
- Fixed invalid draft predicates being frozen as accepted expected results during
  protocol correction. Scoped repairs preserve valid and reviewed expectations;
  rejected changes retain assertion IDs and before/proposed values and can use
  the remaining shared correction allowance. Structural failures and proposed
  draft assertion changes are retained for review.
- Added exact decoded CSV row comparison with `csv_equals` and finite,
  case-sensitive literal alternatives with `contains_any`. Authoring now explains
  and validates that `matches` uses `*` wildcards rather than regular expressions.
- Fixed provider JSON/schema failures bypassing protocol correction and losing
  their validation details. Authoring records now retain bounded, redacted
  rejected output with exact error paths and codes. Protocol schema failures
  share the existing two-correction limit and spending cap; rejected content is
  never executed. Network failures, refusals, and incomplete provider output are
  not automatically retried.
- Fixed protocol authoring that emitted invalid obligation bindings or treated
  document descriptions as file references. Generation now supplies exact source
  bindings and runtime rules, normalizes equivalent notation, and validates each
  response and required file before creating a candidate.
- Added at most two technical correction requests per generation command under
  its existing spending ceiling. Corrections preserve reviewed coverage and
  expected results; unresolved technical errors remain incomplete diagnostics
  instead of becoming user questions or runtime file-open failures.
- Included required normative file excerpts in protocol-authoring context and
  preview. Clarified that read-only discovery still permits authoring automated
  tests for later approved execution.
- Added context-based answer suggestions to interactive `urs resolve`, with
  accept, edit, concrete alternatives, and skip choices. Suggestions identify
  their evidence and distinguish documented requirements from implementation
  behavior. Suggestions and requirement proposals share one command budget;
  `--answers-only` remains an offline typed-answer workflow.
- Fixed generated URS references that confused source provenance with normative
  filenames. Drafts now normalize supported provenance and pass shared structural
  checks before publication. Added `urs check --fix-references` for reviewed,
  evidence-backed repairs to older drafts, with retained snapshots and no AI call.
  Genuine missing normative files remain blockers.
- Added `provenarium urs resolve` and editable answer fields beside URS questions.
  The CLI saves answers as they are submitted, supports skipping and revisiting
  questions, and can capture answers offline with `--answers-only`.
- Added targeted requirement-change proposals with question/answer context,
  before/after review, explicit application, retained questions, and local
  resolution history. Saved proposals can be reviewed and applied offline;
  stale proposals are rejected. Changed answers become pending again.
- Added a Quick/Standard/Thorough selector to interactive drafting and review
  before the spending confirmation. It shows each level's spending cap and remembers the
  selected level; explicit `--thoroughness` and scripted `--yes` skip the selector.
- Changed `provenarium urs` to collect application context and a deployed URL,
  then draft requirements without a general interview or route-selection menu.
  `urs generate --context <location> --url <url>` supports direct input, and
  `--brief` is optional guidance. Linked context and the target URL are reused.
- Grounded draft and review questions in supplied material and observed controls.
  Missing decisions remain specific open questions. Untouched blank templates
  can be filled, while existing requirements files are preserved as new revisions.
- Clarified the requirements workflow: templates and AI drafts are alternative
  starting points, followed by reviewed requirements, protocol generation, and
  the existing approval and execution flow.
- Fixed `provenarium browser install` to use the exported Playwright CLI entry
  point. Package verification now exercises browser setup from local and global
  installations.

## 0.1.0 — prerelease

- Added local URS authoring, context links, typed IOQ plans, hash-based approval,
  fixed Playwright execution, and evidence-linked HTML/PDF/CSV reporting.
- Added selectable OpenAI and Anthropic authoring with Quick/Standard/Thorough
  presets, per-command spending reservations, private credentials, and retained
  incomplete drafts.
- Added a synthetic application and unchanged-package good/defective demonstration,
  deterministic CI, and clean npm archive verification.
- Added corrected and deliberately faulty scientific demos on GitHub Pages,
  independent browser-only protocols, and live-site CLI verification.
- Added installable GitHub release archives with SHA-256 checksums and verification
  of the same archive on macOS and Ubuntu before publication.
- Added `provenarium uninstall`, including installation checks, an interactive
  confirmation, `--yes`, and `--dry-run`. Validation data, credentials, and shared
  browser files are retained.

Releases are distributed through GitHub; the package is not published to the npm
registry. Live-provider authoring evaluations remain pending at the user's request;
scripted provider checks establish adapter behavior, not real-model authoring quality.
