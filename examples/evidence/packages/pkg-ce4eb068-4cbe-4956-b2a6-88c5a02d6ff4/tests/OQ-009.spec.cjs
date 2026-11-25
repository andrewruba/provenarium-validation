// Generated from plan PLAN-SAMPLE-REGISTER. Edit the candidate plan, then regenerate.
'use strict';
module.exports = function register({ test, runtime }) {
  test("OQ-009 Receipt export contents and ordering", async () => {
    await runtime.executeCase("OQ-009", {
  "id": "OQ-009",
  "title": "Receipt export contents and ordering",
  "classification": "OQ",
  "requirements": [
    "URS-EXP-001"
  ],
  "actor": "operator",
  "prerequisites": [
    "Run before other record-creating cases against the declared empty starting data directory."
  ],
  "manual": false,
  "steps": [
    {
      "id": "OQ-009-LOGIN",
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
          "id": "OQ-009-AUTH",
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
          "id": "OQ-009-LOGIN-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-009-1",
      "instruction": "Create three export examples in reverse date and identifier order.",
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
          "value": "EXPORT-B"
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
          "value": "2026-01-17"
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
          "value": "EXPORT-C"
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
          "value": "2026-01-16"
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
          "value": "EXPORT-A"
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
          "value": "2026-01-16"
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
          "id": "OQ-009-CREATED",
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
          "id": "OQ-009-1-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-009-2",
      "instruction": "Download the CSV and compare headers, row values, and date order.",
      "actions": [
        {
          "op": "download",
          "locator": {
            "by": "role",
            "value": "Download receipt CSV",
            "role": "link",
            "exact": true
          },
          "save_as": "export"
        }
      ],
      "assertions": [
        {
          "id": "OQ-009-HEADERS",
          "variable": "export.text",
          "read": "text",
          "comparison": "contains",
          "expected": "Sample ID,Storage location,Receipt date,Mass (mg),Volume (mL),Concentration (mg/mL),Status\r\n"
        },
        {
          "id": "OQ-009-ROWS",
          "variable": "export.text",
          "read": "text",
          "comparison": "equals",
          "expected": "Sample ID,Storage location,Receipt date,Mass (mg),Volume (mL),Concentration (mg/mL),Status\r\nEXPORT-A,Ambient,2026-01-16,12,3,4.000,Received\r\nEXPORT-C,Chilled,2026-01-16,12,3,4.000,Received\r\nEXPORT-B,Chilled,2026-01-17,12,3,4.000,Received\r\n"
        }
      ],
      "evidence": [
        {
          "id": "OQ-009-2-OBS",
          "kind": "observation",
          "required": true
        },
        {
          "id": "OQ-009-DOWNLOAD",
          "kind": "download",
          "variable": "export",
          "required": true
        }
      ]
    }
  ],
  "citations": []
});
  });
};
