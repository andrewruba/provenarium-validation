// Generated from plan PLAN-SAMPLE-REGISTER. Edit the candidate plan, then regenerate.
'use strict';
module.exports = function register({ test, runtime }) {
  test("OQ-007 Duplicate rejection and identifier equivalence", async () => {
    await runtime.executeCase("OQ-007", {
  "id": "OQ-007",
  "title": "Duplicate rejection and identifier equivalence",
  "classification": "OQ",
  "requirements": [
    "URS-REC-002"
  ],
  "actor": "operator",
  "prerequisites": [
    "Qualification starts with an empty synthetic sample data directory. This case uses distinct identifiers."
  ],
  "manual": false,
  "steps": [
    {
      "id": "OQ-007-LOGIN",
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
          "id": "OQ-007-AUTH",
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
          "id": "OQ-007-LOGIN-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-007-1",
      "instruction": "Create a receipt for DUP-104.",
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
          "value": "DUP-104"
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
          "id": "OQ-007-CREATED",
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
          "id": "OQ-007-1-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-007-2",
      "instruction": "Attempt a duplicate with surrounding spaces and changed storage.",
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
          "value": "  DUP-104  "
        },
        {
          "op": "select",
          "locator": {
            "by": "label",
            "value": "Storage location",
            "exact": true
          },
          "value": "Ambient"
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
          "id": "OQ-007-DENIED",
          "locator": {
            "by": "css",
            "value": "[role=\"alert\"]",
            "exact": true
          },
          "read": "text",
          "comparison": "contains",
          "expected": "Sample ID already exists."
        }
      ],
      "evidence": [
        {
          "id": "OQ-007-2-OBS",
          "kind": "observation",
          "required": true
        },
        {
          "id": "OQ-007-2-SCREEN",
          "kind": "screenshot",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-007-3",
      "instruction": "Reopen records and verify the original is the only matching row.",
      "actions": [
        {
          "op": "navigate",
          "url": "/records"
        }
      ],
      "assertions": [
        {
          "id": "OQ-007-COUNT",
          "locator": {
            "by": "css",
            "value": "table tbody tr:has(td:text-is(\"DUP-104\"))",
            "exact": true
          },
          "read": "count",
          "comparison": "equals",
          "expected": 1
        },
        {
          "id": "OQ-007-ORIGINAL",
          "locator": {
            "by": "css",
            "value": "table tbody tr:has(td:text-is(\"DUP-104\")) td:nth-child(2)",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "Chilled"
        }
      ],
      "evidence": [
        {
          "id": "OQ-007-3-OBS",
          "kind": "observation",
          "required": true
        },
        {
          "id": "OQ-007-3-SCREEN",
          "kind": "screenshot",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-007-4",
      "instruction": "Use a distinct lower-case identifier to verify case sensitivity.",
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
          "value": "dup-104"
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
          "id": "OQ-007-CASE",
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
          "id": "OQ-007-4-OBS",
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
