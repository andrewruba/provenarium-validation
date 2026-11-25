// Generated from plan PLAN-SAMPLE-REGISTER. Edit the candidate plan, then regenerate.
'use strict';
module.exports = function register({ test, runtime }) {
  test("OQ-003 Disabled account login", async () => {
    await runtime.executeCase("OQ-003", {
  "id": "OQ-003",
  "title": "Disabled account login",
  "classification": "OQ",
  "requirements": [
    "URS-AUTH-002"
  ],
  "actor": "disabled",
  "prerequisites": [
    "Qualification starts with an empty synthetic sample data directory. This case uses distinct identifiers."
  ],
  "manual": false,
  "steps": [
    {
      "id": "OQ-003-1",
      "instruction": "Attempt login using the disabled binding; do not replace the account if denied.",
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
          "binding": "disabled.username"
        },
        {
          "op": "fillSecret",
          "locator": {
            "by": "label",
            "value": "Password",
            "exact": true
          },
          "binding": "disabled.password"
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
          "id": "OQ-003-A1",
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
          "id": "OQ-003-A2",
          "variable": "denied.status",
          "read": "text",
          "comparison": "equals",
          "expected": 401
        }
      ],
      "evidence": [
        {
          "id": "OQ-003-1-OBS",
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
