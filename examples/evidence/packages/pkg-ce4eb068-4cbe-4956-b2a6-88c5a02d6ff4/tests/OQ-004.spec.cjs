// Generated from plan PLAN-SAMPLE-REGISTER. Edit the candidate plan, then regenerate.
'use strict';
module.exports = function register({ test, runtime }) {
  test("OQ-004 Nonexistent account login", async () => {
    await runtime.executeCase("OQ-004", {
  "id": "OQ-004",
  "title": "Nonexistent account login",
  "classification": "OQ",
  "requirements": [
    "URS-AUTH-002"
  ],
  "actor": "nonexistent",
  "prerequisites": [
    "Qualification starts with an empty synthetic sample data directory. This case uses distinct identifiers."
  ],
  "manual": false,
  "steps": [
    {
      "id": "OQ-004-1",
      "instruction": "Attempt login using the nonexistent binding; do not replace the account if denied.",
      "actions": [
        {
          "op": "navigate",
          "url": "/login"
        },
        {
          "op": "fillSecret",
          "locator": {
            "by": "label",
            "value": "Username",
            "exact": true
          },
          "binding": "nonexistent.username"
        },
        {
          "op": "fillSecret",
          "locator": {
            "by": "label",
            "value": "Password",
            "exact": true
          },
          "binding": "nonexistent.password"
        },
        {
          "op": "click",
          "locator": {
            "by": "role",
            "value": "Sign in",
            "role": "button",
            "exact": true
          }
        },
        {
          "op": "request",
          "url": "/api/samples",
          "method": "GET",
          "as": "denied"
        }
      ],
      "assertions": [
        {
          "id": "OQ-004-A1",
          "locator": {
            "by": "css",
            "value": "[role=\"alert\"]",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "Login denied."
        },
        {
          "id": "OQ-004-A2",
          "variable": "denied.status",
          "read": "text",
          "comparison": "equals",
          "expected": 401
        }
      ],
      "evidence": [
        {
          "id": "OQ-004-1-OBS",
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
