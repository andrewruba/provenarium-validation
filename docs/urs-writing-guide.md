# Writing useful requirements

The editable requirements authority is `urs.yaml`. HTML and PDF views are generated from that file. A requirement describes what a user needs the system to do; it does not need browser selectors, automation code, or a separate assertion language.

Start with `provenarium urs`, supply source code or documents and the deployed
application URL, and review the resulting draft. You do not need to describe the
application in a preliminary interview. The authoring step reads the material
first and records specific missing decisions as open questions.

You can provide the same inputs directly:

```sh
provenarium urs generate --context ../my-app --context ./design.docx \
  --url https://app.example.com
```

Repeat `--context` for additional sources. These links are reused when generating
the protocol. An optional `--brief brief.md` can narrow the scope or provide
guidance that is absent from the source material.

If you prefer to write from scratch, run `provenarium urs template --out
urs.yaml` and fill in the file. If you already have requirements in the supported
YAML format, start with `provenarium urs check` and that file's path.

After editing, run `provenarium urs check urs.yaml`. Use the filename printed by
setup if it generated a revision; existing files are
preserved. Resolve missing information and open questions before continuing:

```sh
provenarium generate --urs urs.yaml --url https://app.example.com
```

This command writes the IOQ protocol and tests from the reviewed requirements.
`urs generate` writes the requirements themselves. Both generated requirements
and generated protocols need human review before approval.

## Review the intended use and specific gaps

Check that the draft describes the people using the application, the process it
supports, decisions its outputs influence, and explicit exclusions. Confirm its
roles and inputs/outputs against the supplied material. For calculations, review
the independently justified method, example values, units, precision, and
tolerances.

Open questions should identify a concrete missing decision: for example,
"The CSV specification does not state the dilution-factor precision. How many
decimal places should that column retain?" Supply the missing fact or reference
in the requirements file and resolve the corresponding question. Do not invent
an acceptance value merely to complete a draft.

Do not derive expected results by copying the application's current outputs. A correct test can fail against a defective application. A source-code observation is context, not automatic acceptance of its behavior.

## Make obligations observable

- Give every requirement a stable ID and one cohesive behavior.
- State who can do what, under which conditions, and what is displayed, retained, calculated, or rejected.
- Specify defaults separately from mandatory or editable values.
- Describe blank, malformed, invalid, and boundary inputs where relevant.
- Name table columns, units, row meaning, ordering, and relationships to inputs.
- State what remains after saving, reopening, exporting, or changing roles.
- Preserve uncertainty as an open question. Do not invent retention periods, permissions, or scientific expectations to complete a draft.
- Use non-applicability only with a reason grounded in intended use. Missing application functionality is not itself a reason to exclude a requirement.

For example:

```yaml
- id: URS-REC-002
  title: Duplicate receipt prevention
  statement: >-
    Saving an existing Sample ID shall be rejected with an explanation.
    Surrounding spaces shall be ignored and identifiers shall be case-sensitive.
    The original record shall remain unchanged and no second record shall be created.
```

Tables can hold field names, data types, choices, requiredness, defaults, and limits. Keep larger permission matrices or calculation examples in referenced files. Normative files needed by tests are copied into the approved package.

## Review the generated coverage

The generated test plan decomposes detailed requirements into readable clause groups. Each group references assertions or an explicit manual procedure. Review that decomposition alongside the original URS: structural checks can verify links but cannot prove semantic completeness.

Unknown expected behavior blocks approval. A fully specified manual procedure may remain planned and will appear as `manual_pending` in executed reports. Passing automated cases do not complete outstanding manual work.

`--detail concise` reduces URS elaboration. `--thoroughness quick|standard|thorough` controls paid authoring effort and relevant scenario breadth. All levels preserve the same approval requirements.

The [synthetic sample URS](../examples/sample-validation/urs.yaml) illustrates the format, including fields, independent calculation examples, negative access, exports, attachments, and external recovery evidence.
