// Generated from plan PLAN-SAMPLE-REGISTER. Edit the candidate plan, then regenerate.
'use strict';
module.exports = function register({ test, runtime }) {
  test("OQ-002 Incorrect password for active account", async () => {
    await runtime.executeCase("OQ-002", {
  "id": "OQ-002",
  "title": "Incorrect password for active account",
  "classification": "OQ",
  "requirements": [
    "URS-AUTH-002"
  ],
  "actor": "wrong",
  "prerequisites": [
    "Qualification starts with an empty synthetic sample data directory. This case uses distinct identifiers."
  ],
  "manual": false,
  "steps": [
    {
      "id": "OQ-002-1",
      "instruction": "Attempt login using the wrong binding; do not replace the account if denied.",
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
          "binding": "wrong.username"
        },
        {
          "op": "fillSecret",
          "locator": {
            "by": "label",
            "value": "Password",
            "exact": true
          },
          "binding": "wrong.password"
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
          "id": "OQ-002-A1",
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
          "id": "OQ-002-A2",
          "variable": "denied.status",
          "read": "text",
          "comparison": "equals",
          "expected": 401
        }
      ],
      "evidence": [
        {
          "id": "OQ-002-1-OBS",
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
