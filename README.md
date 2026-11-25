# Provenarium Validation

A command-line tool project for software validation in pharma and other GxP
workflows, centered on user requirements, readable protocols, and test evidence.

## Design

The intended workflow turns a User Requirements Specification (URS) into a
human-readable Installation and Operational Qualification (IOQ) protocol and
reviewable, deterministic Playwright tests.

```text
provenarium urs template
provenarium urs generate
provenarium context add app ../my-app
provenarium context add design ./design.docx
provenarium generate --urs urs.yaml --url https://app.example.com
provenarium approve
provenarium run
provenarium report
```

The CLI design includes:

- Blank, AI-assisted, or human-authored YAML requirements, informed by linked
  source code, design documents, and other context.
- AI-assisted IOQ and test authoring, followed by approval that freezes files
  by hash. Execution and reporting use fixed procedures without model calls.
- Guided terminal prompts for the user's provider API key and the application
  accounts needed for positive and negative access tests. Secrets stay out of
  requirements, generated tests, and reports.
- An executed record, screenshots and other evidence, and a requirements
  traceability matrix.

Users supply context appropriate to the deployed application. Hashes identify
inputs and artifacts; the tool does not verify source-to-deployment alignment.
Validation decisions remain with the organization responsible for intended use.
