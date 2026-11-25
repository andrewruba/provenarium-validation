// Generated from plan PLAN-SAMPLE-REGISTER. Edit the candidate plan, then regenerate.
'use strict';
module.exports = function register({ test, runtime }) {
  test("OQ-011 Operator denial and supervisor approval", async () => {
    await runtime.executeCase("OQ-011", {
  "id": "OQ-011",
  "title": "Operator denial and supervisor approval",
  "classification": "OQ",
  "requirements": [
    "URS-PERM-001"
  ],
  "actor": "operator",
  "prerequisites": [
    "Qualification starts with an empty synthetic sample data directory. This case uses distinct identifiers."
  ],
  "manual": false,
  "steps": [
    {
      "id": "OQ-011-LOGIN",
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
          "id": "OQ-011-AUTH",
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
          "id": "OQ-011-LOGIN-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-011-1",
      "instruction": "Create a sample as an operator and attempt approval through HTTP.",
      "actions": [
        {
          "op": "navigate",
          "url": "/samples"
        },
        {
          "op": "fill",
          "locator": {
            "by": "label",
            "value": "Sample ID",
            "exact": true
          },
          "value": "PERMISSION-104"
        },
        {
          "op": "select",
          "locator": {
            "by": "label",
            "value": "Storage location",
            "exact": true
          },
          "value": "Chilled"
        },
        {
          "op": "fill",
          "locator": {
            "by": "label",
            "value": "Receipt date",
            "exact": true
          },
          "value": "2026-01-15"
        },
        {
          "op": "fill",
          "locator": {
            "by": "label",
            "value": "Mass (mg)",
            "exact": true
          },
          "value": "12"
        },
        {
          "op": "fill",
          "locator": {
            "by": "label",
            "value": "Volume (mL)",
            "exact": true
          },
          "value": "3"
        },
        {
          "op": "click",
          "locator": {
            "by": "role",
            "value": "Save sample",
            "role": "button",
            "exact": true
          }
        },
        {
          "op": "request",
          "url": "/api/approve",
          "method": "POST",
          "body": {
            "sampleId": "PERMISSION-104"
          },
          "as": "approvalDenied"
        }
      ],
      "assertions": [
        {
          "id": "OQ-011-HIDDEN",
          "locator": {
            "by": "role",
            "value": "Approve sample",
            "role": "button",
            "exact": true
          },
          "read": "visible",
          "comparison": "equals",
          "expected": false
        },
        {
          "id": "OQ-011-DENIED",
          "variable": "approvalDenied.status",
          "read": "text",
          "comparison": "equals",
          "expected": 403
        }
      ],
      "evidence": [
        {
          "id": "OQ-011-1-OBS",
          "kind": "observation",
          "required": true
        },
        {
          "id": "OQ-011-1-SCREEN",
          "kind": "screenshot",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-011-2",
      "instruction": "Sign out before changing to the declared supervisor actor.",
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
          "op": "session",
          "actor": "supervisor"
        }
      ],
      "assertions": [],
      "evidence": []
    },
    {
      "id": "OQ-011-SUP-LOGIN",
      "instruction": "Sign in using the declared supervisor credential binding.",
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
          "binding": "supervisor.username"
        },
        {
          "op": "fillSecret",
          "locator": {
            "by": "label",
            "value": "Password",
            "exact": true
          },
          "binding": "supervisor.password"
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
          "id": "OQ-011-SUP-AUTH",
          "locator": {
            "by": "testId",
            "value": "identity",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "Signed in as supervisor (supervisor)"
        }
      ],
      "evidence": [
        {
          "id": "OQ-011-SUP-LOGIN-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-011-3",
      "instruction": "Approve the sample using the supervisor browser controls, then reopen records.",
      "actions": [
        {
          "op": "navigate",
          "url": "/records"
        },
        {
          "op": "fill",
          "locator": {
            "by": "label",
            "value": "Sample ID to approve",
            "exact": true
          },
          "value": "PERMISSION-104"
        },
        {
          "op": "click",
          "locator": {
            "by": "role",
            "value": "Approve sample",
            "role": "button",
            "exact": true
          }
        },
        {
          "op": "navigate",
          "url": "/samples"
        },
        {
          "op": "navigate",
          "url": "/records"
        }
      ],
      "assertions": [
        {
          "id": "OQ-011-APPROVED",
          "locator": {
            "by": "css",
            "value": "table tbody tr:has(td:text-is(\"PERMISSION-104\")) td:nth-child(7)",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "Approved"
        }
      ],
      "evidence": [
        {
          "id": "OQ-011-3-OBS",
          "kind": "observation",
          "required": true
        },
        {
          "id": "OQ-011-3-SCREEN",
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
