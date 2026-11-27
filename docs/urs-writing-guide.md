# Review the requirements

Start with `provenarium validate` and provide the source material and deployed
application URL. The CLI drafts `urs.yaml` when it is missing. To use your own
requirements, save them as `urs.yaml` in the validation project and run the same
command.

Check that the requirements explain who uses the system, the process it supports,
and how users rely on its outputs. For calculations, review the independent
method, example values, units, precision, and tolerances.

- Give each requirement a stable ID and describe one cohesive behavior.
- State who can do what, under which conditions, and what the app should display,
  save, calculate, or reject.
- Name required defaults, limits, table columns, units, and sorting rules.
- Describe what stays after reopening or exporting. Specify relevant invalid and
  boundary inputs.

An open question should ask for a concrete missing fact, such as how many
decimal places a CSV column should retain. `validate` proposes answers and shows
the affected requirements together. Accept or edit the proposals before
approving the URS. The CLI keeps the decisions and their sources in `urs.yaml`.
Changing a question or answer can reopen the decision for review.

Use `citations` for source material that informed a requirement and
`references` for actual required files, such as an independent calculation
worksheet. The application's current output is an observation. Expected values
come from the accepted requirements and independent reference calculations.

After you approve the resolved URS, the same command prepares, dry-runs, and
executes the checked IOQ. [CLI reference](cli-reference.md)
