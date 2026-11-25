# Deliberate defects — evaluator spoilers

Keep this file out of AI authoring context when testing independent discovery.
Faulty mode enables all four defects. Correct mode disables them; `--defects`
selects a comma-separated subset. The requirements and approved expectations are
identical for both modes.

| Defect switch | Fault | Independent expectation | Expected failing case |
| --- | --- | --- | --- |
| `concentration-units` | Converts µg/mL to mg/mL by dividing by 100 instead of 1000. | Stock 10 mg/mL, target 100 µg/mL, final 10 mL needs 0.100 mL stock and 9.900 mL diluent. The faulty app gives 1.000 mL stock. | `OQ-UNIT-CONVERSION` |
| `zero-volume` | Accepts a final volume of zero and saves a meaningless preparation. | Reject with a field-specific error and leave records unchanged. | `OQ-ZERO-VOLUME` |
| `duplicate-id` | Replaces the original preparation when its trimmed, case-sensitive Sample ID is reused. | Reject the duplicate with HTTP 409 and preserve the original values. | `OQ-DUPLICATE-ID` |
| `csv-units` | Multiplies stock volume by 1000 in the CSV while keeping its mL column heading. | Export the same stock volume in mL as displayed, with three decimal places. | `OQ-CSV-EXPORT` |

Normal same-unit calculations can still pass in faulty mode. The defects are
therefore detectable through mixed-unit, boundary, record-integrity, and export
checks, rather than an obvious broken homepage. The CSV case starts with its own
records before later cases can add records affected by other defects.

The automatic comparison verifies all four faults together. The browser workflow
regression test additionally enables each defect separately and requires exactly
its associated case to fail. This prevents one failure from concealing another.

All calculations assume a simple dilution with additive volumes. The app does not
model volume contraction, purity, density, molarity, serial dilution, instrument
accuracy, or pipette limits. It is a synthetic validation exercise, not a laboratory
procedure recommendation.
