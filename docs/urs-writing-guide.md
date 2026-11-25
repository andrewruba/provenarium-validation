# Writing useful requirements

The editable requirements authority is `urs.yaml`. HTML and PDF views are generated from that file. A requirement describes what a user needs the system to do; it does not need browser selectors, automation code, or a separate assertion language.

Start with `provenarium urs template --out urs.yaml`, edit the file, then run `provenarium urs check urs.yaml`. A blank template is a starting point, not a protocol-ready specification. `urs generate` can instead draft requirements from a brief or an interactive interview. AI proposals remain subject to review.

## Describe the intended use

Identify the people using the application, the process it supports, decisions its outputs influence, and explicit exclusions. List meaningful roles and inputs/outputs. For calculations, identify the independently justified method, example values, units, precision, and tolerances.

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
