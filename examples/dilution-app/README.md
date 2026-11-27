# Dilution Bench server fixture

This Node fixture exposes a web form and HTTP interface for the dilution
calculator. The [published browser demo](../../docs/testing-hosted-dilution.md)
is the starting point for the validation workflow.

Start the server fixture from the repository with `npm run demo:dilution`. By
default it listens on port 4174. The E2E tests exercise corrected and faulty
behavior against independent expectations in `examples/dilution-validation`.
Run `npm run build` and `npm run test:e2e` to verify the fixtures.

The hosted fixture isolates test data under `/w/<id>/`. The browser-only demo
uses local storage instead. This synthetic application is a testing fixture.
