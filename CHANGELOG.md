# Changelog

## Unreleased

- Added a Quick/Standard/Thorough selector to interactive authoring before the
  spending confirmation. It shows each level's spending cap and remembers the
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
