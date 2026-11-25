# Saved synthetic qualification evidence

These are retained example records from local execution, not a live hosted demo
or a customer validation conclusion. Both runs use the same approved package.
The target URL records the temporary local server used at execution time.

| Application variant | Automated results | Manual work |
| --- | --- | --- |
| Working | 12 passed | 1 pending |
| Deliberately defective | 11 passed, 1 failed | 1 pending |

The defective application permits duplicate identifiers. Case `OQ-007` exposes
that defect under unchanged expectations for `URS-REC-002`.

- [Approved IOQ](packages/pkg-ce4eb068-4cbe-4956-b2a6-88c5a02d6ff4/ioq.html)

- [Working application report](runs/run-20261125T013529104Z-90ceef1d/reports/executed-record.html)

- [Deliberately defective application report](runs/run-20261125T013534911Z-065afdc4/reports/executed-record.html)

Each run directory contains `run.json`, append-only observations, retained
artifacts, HTML/PDF executed records, and CSV traceability. The approval directory
contains the requirements, plan, compiled tests, fixtures, protocol, and recorded
file hashes. Passwords and browser authentication storage are excluded.

Regenerate the selected saved report without a provider or live application:

```sh
node bin/provenarium.mjs --project examples/evidence report
```

To execute a fresh demonstration, follow the installation guide and use the
reviewed source plan in `examples/sample-validation`. The saved package here
records a historical local target port and should be treated as example evidence.
