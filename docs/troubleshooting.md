# Troubleshooting

## Requirements are still open

Run `provenarium validate` in the same project. Open questions identify missing
decisions. Review the proposed answers and the affected requirements together.
Keep the answers and resolution metadata in `urs.yaml` so the CLI can trace
each accepted decision. See the [requirements guide](urs-writing-guide.md).

If the CLI names a missing reference, put the real supporting file at the
project-relative path declared in the URS. Put source observations in
`citations` and use `references` for actual required files.

## The dry run failed

Open the IOQ and dry run paths printed by `validate`. The output identifies
the failed case and step or assertion. Check the expected and actual values in
the retained diagnostics. If the application differs from an accepted
requirement, address the application behavior or review the requirement with
the people who own it. Rerun `provenarium validate` in the same project to check
the saved tests. Formal execution starts after the dry run passes.

## A provider request failed

Read the error and the printed authoring record. An HTTP error may include the
provider's code, message, and request ID. Check the API key or provider account
when the error identifies an access problem. A request rejected by a local
limit never reaches the provider. Usage and retained work are recorded under
`drafts/`.

## Chromium could not start

Validation installs the Playwright Chromium build it needs if the executable is
missing. A failed download may need network access. If Linux reports missing
system libraries, install the libraries listed by Playwright and rerun
`provenarium validate`. See the [installation guide](installation.md).
