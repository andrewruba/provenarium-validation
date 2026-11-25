# Implementation verification

Verification recorded on 25 November 2026 UTC. This is the `0.1.0` implementation
candidate; no npm package has been published. The browser-only demonstration apps
are live on GitHub Pages; see the [deployment guide](deployment.md).

## Current CI and published demos

- [CI verification](https://github.com/andrewruba/provenarium-validation/actions/runs/45548265984)
  passed formatting, types, builds, 81 unit/contract tests, 16 Chromium end-to-end
  tests, and clean npm archive installation on macOS and Ubuntu.
- [Published Pages validation](https://github.com/andrewruba/provenarium-validation/actions/runs/45548836347)
  verified the deployed revision with the main CLI: 11 passes for the corrected
  app and seven passes plus exactly four expected failures for the faulty app.
  See the [Pages testing guide](testing-hosted-dilution.md) to repeat the comparison.

## Initial implementation checks

- Formatting, strict TypeScript checks, and builds pass.
- 64 unit/contract tests pass, including both provider transports, spending
  reservations, incomplete drafts, context extraction, approval/coverage checks,
  path boundaries, credential-store errors, and bounded HTTP handling.
- 13 Chromium end-to-end tests pass, including discovery, authenticated sessions,
  secret capture, short-storage-value redaction, WebSocket boundaries, interrupted
  execution, and the complete good/defective qualification journey.
- The same suites were exercised on macOS ARM64 and Ubuntu 24.04 ARM64 using
  Node.js 26.13.0 and Playwright 1.65.1. CI defines macOS and Ubuntu jobs; CPU
  variants outside the local verification environments have not been locally
  verified.
- A clean installed npm archive runs from a separate project with spaces in its
  path and no project `node_modules`, then approves, executes, and reports both
  application variants. Runtime execution does not install or compile tests.
- macOS secure credential storage passed a round trip using a temporary synthetic
  entry that was removed afterward. Linux without Secret Service uses the
  documented session-only route; its interactive secure-store lifecycle has not
  been exercised against a live desktop Secret Service.
- Readable IOQ and executed-record PDFs were visually reviewed, including long
  tables, repeated headers, screenshots, failure rows, and explicitly unexecuted
  steps. Saved approval inputs and all 23 retained evidence artifacts match their
  recorded hashes.

## Demonstration outcome

One approved package produces 12 automated passes on the working application,
then 11 passes and one meaningful duplicate-prevention failure on the deliberately
defective application. The manual recovery review remains pending in both runs.
Prior records remain intact. The evidence fixture tests also verify rejection of
changed approved files, ignored unapproved test files, and explicit report
warnings for missing or altered evidence.

Browse [the saved example evidence](../examples/evidence/README.md). These are
historical synthetic records, not a live demo or customer validation decision.

## Explicitly pending

Live OpenAI and Anthropic authoring-quality evaluations remain pending at the
user's request. No paid provider calls were made. Scripted fixtures establish
transport, validation, budgeting, and failure behavior; they do not establish
that real models consistently author useful qualification protocols.

Complete one capped Standard evaluation per provider using privately supplied
keys, recording authoring quality, actual requirements coverage, remaining
questions, and cost. Real-provider authoring quality remains unverified until
those evaluations are completed. npm package publication is separate from source
and demo deployment.

The npm registry returned no existing public package for `provenarium-validation`
at verification time. This check does not reserve the name or guarantee that a
future publication will be accepted.
