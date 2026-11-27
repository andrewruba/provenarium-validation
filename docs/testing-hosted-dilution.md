# Validate Dilution Bench

Dilution Bench uses the standard dilution equation `C₁V₁ = C₂V₂`. It provides
unit selection, browser-local records, and CSV exports. Try the main workflow
against the corrected variant from a fresh validation project.

```sh
provenarium validate --context /path/to/provenarium-validation/examples/dilution-pages \
  --url https://andrewruba.github.io/provenarium-validation/correct/
```

Review the proposed requirements and the calculation expectations before
approval. The app source is context for drafting. Use independent calculations
for expected results.

Try the same flow in a separate validation project using the
[faulty target](https://andrewruba.github.io/provenarium-validation/faulty/).
Its deliberate defects affect unit conversion, zero-volume handling, duplicate
identifiers, and CSV output. A dry run that finds a mismatch retains the IOQ
and the failing checks for review.

Records stay in the browser for each version and workspace. Each test case starts
in a separate browser context. Shared server persistence and authentication are
outside the published demo.

Repository browser tests use fixed independent expectations for the corrected
and faulty builds. Engineers can verify local fixture behavior with
`npm run test:e2e`. The [deployment guide](deployment.md) describes verification
of the published builds.
