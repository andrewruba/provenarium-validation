// Generated from plan PLAN-SAMPLE-REGISTER. Edit the candidate plan, then regenerate.
'use strict';
module.exports = function register({ test, runtime }) {
  test("OQ-001 Active login and logout", async () => {
    await runtime.executeCase("OQ-001", {
  "id": "OQ-001",
  "title": "Active login and logout",
  "classification": "OQ",
  "requirements": [
    "URS-AUTH-001"
  ],
  "actor": "operator",
  "prerequisites": [
    "Qualification starts with an empty synthetic sample data directory. This case uses distinct identifiers."
  ],
  "manual": false,
  "steps": [
    {
      "id": "OQ-001-LOGIN",
      "instruction": "Sign in using the declared operator credential binding.",
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
          "binding": "operator.username"
        },
        {
          "op": "fillSecret",
          "locator": {
            "by": "label",
            "value": "Password",
            "exact": true
          },
          "binding": "operator.password"
        },
        {
          "op": "click",
          "locator": {
            "by": "role",
            "value": "Sign in",
            "role": "button",
            "exact": true
          }
        }
      ],
      "assertions": [
        {
          "id": "OQ-001-AUTH",
          "locator": {
            "by": "testId",
            "value": "identity",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "Signed in as operator (operator)"
        }
      ],
      "evidence": [
        {
          "id": "OQ-001-LOGIN-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-001-2",
      "instruction": "Sign out, then attempt to reopen retained records.",
      "actions": [
        {
          "op": "click",
          "locator": {
            "by": "role",
            "value": "Sign out",
            "role": "button",
            "exact": true
          }
        },
        {
          "op": "navigate",
          "url": "/records"
        }
      ],
      "assertions": [
        {
          "id": "OQ-001-A1",
          "locator": {
            "by": "role",
            "value": "Sign in",
            "role": "button",
            "exact": true
          },
          "read": "visible",
          "comparison": "equals",
          "expected": true
        }
      ],
      "evidence": [
        {
          "id": "OQ-001-2-OBS",
          "kind": "observation",
          "required": true
        },
        {
          "id": "OQ-001-2-SCREEN",
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
