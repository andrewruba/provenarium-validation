# Complete Provenarium Validation v1

## Summary

Deliver a release-ready local CLI implementing the documented requirements → protocol → approval → execution → evidence workflow.

Confirmed choices:

- Package: `provenarium-validation`; terminal command: `provenarium`; license: MIT.
- Platforms: macOS and Linux.
- Outputs: HTML/PDF documents, CSV traceability, and machine-readable records.
- AI: OpenAI and Anthropic, explicitly selected by the user.
- Publication, website changes, hosted execution, and editable Word export remain outside this delivery.

Build the deterministic workflow first, then add AI authoring against its established contracts. Update the existing design to incorporate dual-provider support and thoroughness presets.

## User-facing contract

Retain the documented commands: `urs template/generate/check/render`, `context add/list/remove`, `generate`, `approve`, `run`, `report`, and `auth`.

Add these options to paid authoring commands:

- `--provider openai|anthropic`
- `--model <supported-model>`
- `--thoroughness quick|standard|thorough`
- `--max-spend <USD>`

Prompt for initial provider selection and remember non-secret preferences. Never switch provider or model automatically. Initial model defaults will be [GPT-6.2 Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol) and [Claude Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview), with supported models maintained in a tested capability/pricing catalog.

| Preset | Default ceiling per command | Planned authoring effort |
|---|---:|---|
| Quick | $5 | Targeted discovery, initial draft, and a focused coverage/correctness review. |
| Standard — default | $15 | Quick plus another pass examining relevant boundaries, negative access, persistence, and exports. |
| Thorough | $40 | Standard plus an adversarial review of conflicting sources, overlooked conditions, and consequential combinations. |

Presets increase investigation and relevant scenario breadth. All retain the same requirements and approval rules. Stop early when additional review finds nothing actionable; budgets are ceilings, not spending targets.

Keep `--detail detailed|concise` independent: it controls URS elaboration. Budget exhaustion preserves an incomplete draft with unfinished work identified. A new authoring command receives a new cap; no automatic increases or silent tier downgrades.

## Implementation milestones

### 1. Establish contracts and the synthetic application

- Create one TypeScript/Node package using Commander, Clack prompts, Zod schemas, Playwright, and Vitest. Target [Node 26 LTS](https://nodejs.org/en/about/previous-releases), with pinned dependencies and an npm lockfile.
- Define versioned schemas for the URS, project settings, typed test plan, access inventory, approval record, observations, and run results.
- Preserve ordinary prose and tables in the URS. Store proposed clause decomposition in the test plan, with stable IDs and pointers back to requirement text.
- Require each applicable clause to map to executable assertions or a specified manual procedure. Structural checks establish mapping completeness; reviewers confirm semantic completeness.
- Build a small local sample-receipt application with two roles, account-state fixtures, field constraints, persistence, an independently specified calculation, and CSV export. Include working and deliberately defective variants.

**Gate:** reviewed sample requirements and a hand-authored test plan express every supported operation needed for the demonstration.

### 2. Complete the first deterministic workflow

- Implement blank templates, offline URS checks/rendering, project selection, and safe file creation.
- Compile the typed plan into readable IOQ documents and inspectable JavaScript Playwright tests. Generate expected-result text directly from assertions.
- Make approval compare generated artifacts with the plan, copy the accepted package, and record SHA-256 hashes.
- Execute only approved files through the installed CLI runtime. Validation projects must work without their own dependency installation or runtime compilation.
- Produce observations, screenshots, retained exports, an executed record, and a traceability matrix.

**Gate:** one unchanged approved package passes the working application and produces a requirement-linked failure against the defective variant.

### 3. Complete execution, credentials, and evidence handling

- Implement the bounded action/assertion vocabulary described in the design, including tables, numeric tolerances, uploads/downloads, role sessions, and allowed HTTP checks.
- Use Chromium, one worker, fixed execution settings, and zero whole-test retries. Retesting always creates a new run.
- Resolve the full access inventory before execution. Preserve distinct semantics for fresh login, insufficient permissions, incorrect passwords, disabled accounts, and signed-out access.
- Keep secrets in memory by default and pass them to runner processes through private local IPC. Offer opt-in OS storage through [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node), explicitly selecting Linux Secret Service; unavailable storage falls back to session-only entry.
- Centralize evidence capture and sanitization. Disable raw traces and automatic diagnostic dumps by default. Missing required evidence prevents a passing case.
- Preserve partial observations on interruption. Reports identify missing or changed artifacts and keep manual work visibly pending.

**Gate:** modified packages are refused, unapproved tests cannot execute, interrupted runs remain incomplete, and retained artifacts pass secret-leak checks.

### 4. Implement context and both provider adapters

- Support scoped source/text directories, structured data, DOCX text/tables, text-bearing PDFs, and readable HTTPS HTML.
- Retain citations and hashes of material actually read. Report inaccessible, unsupported, conflicting, or partially extracted sources.
- Implement one provider-neutral authoring workflow with OpenAI Responses and Anthropic Messages adapters. Normalize structured outputs, tool requests, usage, errors, and cancellation.
- Use the same local schema validation and bounded browser tools for both providers. Context and page content cannot introduce executable operations or expand authorized access.
- Reserve a conservative maximum cost before each request, including schemas, tool overhead, and maximum output. Disable hidden retries; retain reservations when billing is uncertain.
- Refuse requests whose cost cannot be bounded using the supported pricing catalog. Show selected sources, provider/model, tier, and cap before paid work.

**Gate:** deterministic fixtures exercise both adapters, all tiers, cancellation, malformed output, unsupported models, and budget exhaustion without paid requests.

### 5. Complete AI-assisted authoring

- Implement brief/interview-based URS drafting, explicit questions, semantic review, source citations, and revisions preserving stable IDs and human edits.
- Add bounded application discovery and generation of plans, fixtures, access requirements, readable protocols, and executable tests.
- Implement the three thoroughness workflows, with additional scenarios justified by requirements and consequences.
- Support feedback against requirement/case/step IDs and show candidate differences.
- Allow rehearsal to correct navigation and locator mistakes. Never adopt observed defects as expectations or remove failing obligations.
- Keep approved packages unchanged; revisions create new candidates and approvals.

**Gate:** each provider can draft useful requirements and author executable tests from the same synthetic application and acceptance rubric.

### 6. Finish documentation and release packaging

- Complete command help, installation instructions, the URS writing guide, troubleshooting, synthetic examples, and representative reports.
- Add MIT licensing and required dependency notices; reuse sibling-project patterns selectively.
- Build and test an npm tarball in clean macOS and Linux environments, with validation projects outside the installation directory.
- Document browser setup explicitly; `run` never installs dependencies.
- Verify package-name availability before publication preparation; report any conflict without silently renaming.
- Prepare release notes and the installable artifact. Do not publish or modify the existing website.

## Verification and completion criteria

Automated CI must cover:

- Blank and human-authored URS routes without provider credentials.
- Clause coverage, document/test equivalence, manual checks, and approval blockers.
- Good/defective application runs under identical approved expectations.
- Changed files, escaping paths/symlinks, extra unapproved tests, missing evidence, interrupted execution, and preserved retests.
- Authentication variants and sentinel secrets appearing in fields, errors, responses, and retained artifacts.
- Prompt-injection attempts and unsupported executable operations.
- Both providers and every thoroughness tier using fixtures, including cap enforcement and ambiguous request failures.
- Clean package installation, projects without `node_modules`, and paths containing spaces.
- HTML/PDF visual inspection covering long tables, page breaks, failures, and evidence links.

Separately run a capped development evaluation for each real provider, using Standard defaults and privately supplied keys. Record authoring quality, actual coverage, remaining questions, and cost. Routine CI and release packaging make no paid calls.

Completion means all six milestones pass, both provider evaluations are documented, and the release artifact reproduces the complete workflow on the tested platforms. Unfinished evaluations or acceptance checks remain explicit outstanding work.
