// Generated from plan PLAN-SAMPLE-REGISTER. Edit the candidate plan, then regenerate.
'use strict';
module.exports = function register({ test, runtime }) {
  test("IQ-001 Observe application identity", async () => {
    await runtime.executeCase("IQ-001", {
  "id": "IQ-001",
  "title": "Observe application identity",
  "classification": "IQ",
  "requirements": [
    "URS-IQ-001"
  ],
  "actor": "visitor",
  "prerequisites": [
    "Qualification starts with an empty synthetic sample data directory. This case uses distinct identifiers."
  ],
  "manual": false,
  "steps": [
    {
      "id": "IQ-001-1",
      "instruction": "Request the public health interface.",
      "actions": [
        {
          "op": "request",
          "url": "/health",
          "method": "GET",
          "as": "health"
        }
      ],
      "assertions": [
        {
          "id": "IQ-001-A1",
          "variable": "health.status",
          "read": "text",
          "comparison": "equals",
          "expected": 200
        },
        {
          "id": "IQ-001-A2",
          "variable": "health.body.application",
          "read": "text",
          "comparison": "equals",
          "expected": "Synthetic sample register"
        }
      ],
      "evidence": [
        {
          "id": "IQ-001-1-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    }
  ],
  "citations": []
});
  });
};
