// Generated from plan PLAN-SAMPLE-REGISTER. Edit the candidate plan, then regenerate.
'use strict';
module.exports = function register({ test, runtime }) {
  test("OQ-005 Signed-out browser and HTTP access", async () => {
    await runtime.executeCase("OQ-005", {
  "id": "OQ-005",
  "title": "Signed-out browser and HTTP access",
  "classification": "OQ",
  "requirements": [
    "URS-AUTH-003"
  ],
  "actor": "visitor",
  "prerequisites": [
    "Qualification starts with an empty synthetic sample data directory. This case uses distinct identifiers."
  ],
  "manual": false,
  "steps": [
    {
      "id": "OQ-005-1",
      "instruction": "Open retained records and request records without authenticating.",
      "actions": [
        {
          "op": "navigate",
          "url": "/records"
        },
        {
          "op": "request",
          "url": "/api/samples",
          "method": "GET",
          "as": "visitor"
        }
      ],
      "assertions": [
        {
          "id": "OQ-005-A1",
          "locator": {
            "by": "role",
            "value": "Sign in",
            "role": "button",
            "exact": true
          },
          "read": "visible",
          "comparison": "equals",
          "expected": true
        },
        {
          "id": "OQ-005-A2",
          "variable": "visitor.status",
          "read": "text",
          "comparison": "equals",
          "expected": 401
        },
        {
          "id": "OQ-005-A3",
          "variable": "visitor.body",
          "read": "text",
          "comparison": "equals",
          "expected": {
            "error": "Authentication required"
          }
        }
      ],
      "evidence": [
        {
          "id": "OQ-005-1-OBS",
          "kind": "observation",
          "required": true
        },
        {
          "id": "OQ-005-1-SCREEN",
          "kind": "screenshot",
          "required": true
        }
      ]
    }
  ],
  "citations": []
});
  });
};
