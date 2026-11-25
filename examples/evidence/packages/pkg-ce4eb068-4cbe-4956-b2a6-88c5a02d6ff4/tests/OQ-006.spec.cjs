// Generated from plan PLAN-SAMPLE-REGISTER. Edit the candidate plan, then regenerate.
'use strict';
module.exports = function register({ test, runtime }) {
  test("OQ-006 Receipt fields, retained values and concentration", async () => {
    await runtime.executeCase("OQ-006", {
  "id": "OQ-006",
  "title": "Receipt fields, retained values and concentration",
  "classification": "OQ",
  "requirements": [
    "URS-REC-001",
    "URS-REC-003",
    "URS-CALC-001"
  ],
  "actor": "operator",
  "prerequisites": [
    "Qualification starts with an empty synthetic sample data directory. This case uses distinct identifiers."
  ],
  "manual": false,
  "steps": [
    {
      "id": "OQ-006-LOGIN",
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
          "id": "OQ-006-AUTH",
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
          "id": "OQ-006-LOGIN-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-006-1",
      "instruction": "Observe default storage and blank required inputs.",
      "actions": [
        {
          "op": "navigate",
          "url": "/samples"
        }
      ],
      "assertions": [
        {
          "id": "OQ-006-A1",
          "locator": {
            "by": "label",
            "value": "Storage location",
            "exact": true
          },
          "read": "value",
          "comparison": "equals",
          "expected": "Ambient"
        },
        {
          "id": "OQ-006-BLANK0",
          "locator": {
            "by": "label",
            "value": "Sample ID",
            "exact": true
          },
          "read": "value",
          "comparison": "equals",
          "expected": ""
        },
        {
          "id": "OQ-006-BLANK1",
          "locator": {
            "by": "label",
            "value": "Receipt date",
            "exact": true
          },
          "read": "value",
          "comparison": "equals",
          "expected": ""
        },
        {
          "id": "OQ-006-BLANK2",
          "locator": {
            "by": "label",
            "value": "Mass (mg)",
            "exact": true
          },
          "read": "value",
          "comparison": "equals",
          "expected": ""
        },
        {
          "id": "OQ-006-BLANK3",
          "locator": {
            "by": "label",
            "value": "Volume (mL)",
            "exact": true
          },
          "read": "value",
          "comparison": "equals",
          "expected": ""
        }
      ],
      "evidence": [
        {
          "id": "OQ-006-1-OBS",
          "kind": "observation",
          "required": true
        },
        {
          "id": "OQ-006-1-SCREEN",
          "kind": "screenshot",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-006-2",
      "instruction": "Record DEMO-104 with 12 mg mass and 3 mL volume.",
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
          "value": "DEMO-104"
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
        }
      ],
      "assertions": [
        {
          "id": "OQ-006-A2",
          "locator": {
            "by": "css",
            "value": "[role=\"status\"]",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "Sample saved."
        }
      ],
      "evidence": [
        {
          "id": "OQ-006-2-OBS",
          "kind": "observation",
          "required": true
        },
        {
          "id": "OQ-006-2-SCREEN",
          "kind": "screenshot",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-006-3",
      "instruction": "Navigate away and reopen the retained record. Compare all values and the calculation with the independent reference.",
      "actions": [
        {
          "op": "navigate",
          "url": "/samples"
        },
        {
          "op": "navigate",
          "url": "/records"
        },
        {
          "op": "read",
          "locator": {
            "by": "css",
            "value": "table thead",
            "exact": true
          },
          "as": "headers",
          "read": "table"
        },
        {
          "op": "read",
          "locator": {
            "by": "css",
            "value": "table tbody tr:has(td:text-is(\"DEMO-104\")) td:nth-child(6)",
            "exact": true
          },
          "as": "concentration",
          "read": "text"
        }
      ],
      "assertions": [
        {
          "id": "OQ-006-HEADERS",
          "variable": "headers",
          "read": "text",
          "comparison": "equals",
          "expected": [
            [
              "Sample ID",
              "Storage location",
              "Receipt date",
              "Mass (mg)",
              "Volume (mL)",
              "Concentration (mg/mL)",
              "Status"
            ]
          ]
        },
        {
          "id": "OQ-006-VAL1",
          "locator": {
            "by": "css",
            "value": "table tbody tr:has(td:text-is(\"DEMO-104\")) td:nth-child(1)",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "DEMO-104"
        },
        {
          "id": "OQ-006-VAL2",
          "locator": {
            "by": "css",
            "value": "table tbody tr:has(td:text-is(\"DEMO-104\")) td:nth-child(2)",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "Chilled"
        },
        {
          "id": "OQ-006-VAL3",
          "locator": {
            "by": "css",
            "value": "table tbody tr:has(td:text-is(\"DEMO-104\")) td:nth-child(3)",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "2026-01-15"
        },
        {
          "id": "OQ-006-VAL4",
          "locator": {
            "by": "css",
            "value": "table tbody tr:has(td:text-is(\"DEMO-104\")) td:nth-child(4)",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "12"
        },
        {
          "id": "OQ-006-VAL5",
          "locator": {
            "by": "css",
            "value": "table tbody tr:has(td:text-is(\"DEMO-104\")) td:nth-child(5)",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "3"
        },
        {
          "id": "OQ-006-VAL6",
          "locator": {
            "by": "css",
            "value": "table tbody tr:has(td:text-is(\"DEMO-104\")) td:nth-child(6)",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "4.000"
        },
        {
          "id": "OQ-006-VAL7",
          "locator": {
            "by": "css",
            "value": "table tbody tr:has(td:text-is(\"DEMO-104\")) td:nth-child(7)",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "Received"
        },
        {
          "id": "OQ-006-NUM",
          "variable": "concentration",
          "read": "text",
          "comparison": "numeric",
          "expected": 4,
          "tolerance": 0.0005
        },
        {
          "id": "OQ-006-COUNT",
          "locator": {
            "by": "css",
            "value": "table tbody tr:has(td:text-is(\"DEMO-104\"))",
            "exact": true
          },
          "read": "count",
          "comparison": "equals",
          "expected": 1
        }
      ],
      "evidence": [
        {
          "id": "OQ-006-3-OBS",
          "kind": "observation",
          "required": true
        },
        {
          "id": "OQ-006-3-SCREEN",
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
