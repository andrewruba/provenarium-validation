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
checks browser procedures and retries once if an ambiguous locator has a single
exact match. When the dry run passes, the CLI freezes the checked plan and inputs,
executes them, and prints a summary and report path. A failed dry run leaves the
IOQ and diagnostics available. After addressing the failure, rerun
`provenarium validate` to check the saved tests against the same requirements
and deployment.

Before the first provider request, the CLI previews selected sources and the
spending ceiling. One ceiling covers drafting, question resolution, and test
authoring. OpenAI is the default for new projects. Existing provider settings
remain available. For an existing working URS, see the
[requirements guide](urs-writing-guide.md).

The project contains the editable URS, the readable IOQ and tests in
`candidates/`, and the checked package and execution evidence under
`packages/` and `runs/`. The final report includes case outcomes and a CSV
traceability file. Authoring and dry-run diagnostics are retained under
`drafts/`.
