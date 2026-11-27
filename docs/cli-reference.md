# CLI reference

```sh
provenarium validate --context ../application --url https://app.example.com
```

Run from your validation project or select it with
`provenarium --project /path/to/project validate`. Context takes a file,
directory, or HTTPS page. Repeat `--context` for multiple sources. The project
retains the context links and deployment URL, so later runs can use
`provenarium validate` alone. Use `provenarium validate --help` for input syntax.

The CLI reads `urs.yaml` if it exists. Otherwise it drafts the URS from the
supplied context and deployed app. Review and resolve open questions in the
terminal. The CLI writes a readable requirements view and asks you to approve
the resolved requirements and authorize synthetic browser tests at the displayed
deployment.

After approval it prepares a readable IOQ and Playwright tests. The dry run
checks browser procedures and reruns once after applying confirmed locator fixes,
including alerts targeted by their visible message text. It records the changed
locators and preserves the expected results. When the dry run passes, the CLI
freezes the checked plan and inputs, executes them, and prints a summary and
report path. If the dry run fails, the CLI saves the IOQ and a dry-run report
with expected and observed results. After addressing the failure, rerun
`provenarium validate` to check the saved tests against the same requirements
and deployment.

Before the first provider request, the CLI previews selected sources and the
spending ceiling. One ceiling covers drafting, question resolution, and test
authoring. Use `--provider anthropic` or `--provider openai` to select the
provider for this run. Otherwise the CLI uses the saved project provider or
defaults to OpenAI. For an existing working URS, see the
[requirements guide](urs-writing-guide.md).

The project contains the editable URS, the readable IOQ and tests in
`candidates/`, and the checked package and execution evidence under
`packages/` and `runs/`. The final report includes case outcomes and a CSV
traceability file. Authoring and dry-run diagnostics are retained under
`drafts/`.
