// Generated from plan PLAN-SAMPLE-REGISTER. Edit the candidate plan, then regenerate.
'use strict';
module.exports = function register({ test, runtime }) {
  test("OQ-008 Required inputs and numeric boundaries", async () => {
    await runtime.executeCase("OQ-008", {
  "id": "OQ-008",
  "title": "Required inputs and numeric boundaries",
  "classification": "OQ",
  "requirements": [
    "URS-REC-001",
    "URS-CALC-001"
  ],
  "actor": "operator",
  "prerequisites": [
    "Qualification starts with an empty synthetic sample data directory. This case uses distinct identifiers."
  ],
  "manual": false,
  "steps": [
    {
      "id": "OQ-008-LOGIN",
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
          "id": "OQ-008-AUTH",
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
          "id": "OQ-008-LOGIN-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-008-1",
      "instruction": "Submit a blank receipt.",
      "actions": [
        {
          "op": "navigate",
          "url": "/samples"
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
          "id": "OQ-008-REQUIRED-ID",
          "locator": {
            "by": "css",
            "value": "[role=\"alert\"]",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "Sample ID is required."
        }
      ],
      "evidence": [
        {
          "id": "OQ-008-1-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-008-2",
      "instruction": "Supply an identifier but omit the date.",
      "actions": [
        {
          "op": "fill",
          "locator": {
            "by": "label",
            "value": "Sample ID",
            "exact": true
          },
          "value": "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"
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
          "id": "OQ-008-REQUIRED-DATE",
          "locator": {
            "by": "css",
            "value": "[role=\"alert\"]",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "Receipt date must be a valid calendar date."
        }
      ],
      "evidence": [
        {
          "id": "OQ-008-2-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-008-3",
      "instruction": "Supply the date but omit mass.",
      "actions": [
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
          "id": "OQ-008-REQUIRED-MASS",
          "locator": {
            "by": "css",
            "value": "[role=\"alert\"]",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "Mass must be a number greater than or equal to zero."
        }
      ],
      "evidence": [
        {
          "id": "OQ-008-3-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-008-4",
      "instruction": "Try a negative mass.",
      "actions": [
        {
          "op": "fill",
          "locator": {
            "by": "label",
            "value": "Mass (mg)",
            "exact": true
          },
          "value": "-1"
        },
        {
          "op": "fill",
          "locator": {
            "by": "label",
            "value": "Volume (mL)",
            "exact": true
          },
          "value": "1"
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
          "id": "OQ-008-NEGATIVE-MASS",
          "locator": {
            "by": "css",
            "value": "[role=\"alert\"]",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "Mass must be a number greater than or equal to zero."
        }
      ],
      "evidence": [
        {
          "id": "OQ-008-4-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-008-5",
      "instruction": "Try zero volume.",
      "actions": [
        {
          "op": "fill",
          "locator": {
            "by": "label",
            "value": "Mass (mg)",
            "exact": true
          },
          "value": "0"
        },
        {
          "op": "fill",
          "locator": {
            "by": "label",
            "value": "Volume (mL)",
            "exact": true
          },
          "value": "0"
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
          "id": "OQ-008-ZERO-VOLUME",
          "locator": {
            "by": "css",
            "value": "[role=\"alert\"]",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "Volume must be a number greater than zero."
        }
      ],
      "evidence": [
        {
          "id": "OQ-008-5-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-008-6",
      "instruction": "Accept zero mass, positive volume and the maximum 32-character identifier.",
      "actions": [
        {
          "op": "fill",
          "locator": {
            "by": "label",
            "value": "Volume (mL)",
            "exact": true
          },
          "value": "1"
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
          "id": "OQ-008-ZERO-SAVED",
          "locator": {
            "by": "css",
            "value": "[role=\"status\"]",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "Sample saved."
        },
        {
          "id": "OQ-008-ZERO-CALC",
          "locator": {
            "by": "css",
            "value": "table tbody tr:has(td:text-is(\"ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ\")) td:nth-child(6)",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "0.000"
        },
        {
          "id": "OQ-008-ZERO-NUM",
          "locator": {
            "by": "css",
            "value": "table tbody tr:has(td:text-is(\"ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ\")) td:nth-child(6)",
            "exact": true
          },
          "read": "text",
          "comparison": "numeric",
          "expected": 0,
          "tolerance": 0.0005
        }
      ],
      "evidence": [
        {
          "id": "OQ-008-6-OBS",
          "kind": "observation",
          "required": true
        },
        {
          "id": "OQ-008-6-SCREEN",
          "kind": "screenshot",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-008-LONG",
      "instruction": "Supplement browser checks with server rejection of long.",
      "actions": [
        {
          "op": "request",
          "url": "/api/samples",
          "method": "POST",
          "body": {
            "sampleId": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
            "location": "Ambient",
            "receiptDate": "2026-01-15",
            "mass": "12",
            "volume": "3"
          },
          "as": "rejected"
        }
      ],
      "assertions": [
        {
          "id": "OQ-008-LONG-STATUS",
          "variable": "rejected.status",
          "read": "text",
          "comparison": "equals",
          "expected": 422
        },
        {
          "id": "OQ-008-LONG-ERROR",
          "variable": "rejected.body.error",
          "read": "text",
          "comparison": "equals",
          "expected": "Sample ID must be 1 to 32 characters."
        }
      ],
      "evidence": [
        {
          "id": "OQ-008-LONG-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-008-CHOICE",
      "instruction": "Supplement browser checks with server rejection of choice.",
      "actions": [
        {
          "op": "request",
          "url": "/api/samples",
          "method": "POST",
          "body": {
            "sampleId": "REJECTED",
            "location": "Frozen",
            "receiptDate": "2026-01-15",
            "mass": "12",
            "volume": "3"
          },
          "as": "rejected"
        }
      ],
      "assertions": [
        {
          "id": "OQ-008-CHOICE-STATUS",
          "variable": "rejected.status",
          "read": "text",
          "comparison": "equals",
          "expected": 422
        },
        {
          "id": "OQ-008-CHOICE-ERROR",
          "variable": "rejected.body.error",
          "read": "text",
          "comparison": "equals",
          "expected": "Storage location must be Ambient or Chilled."
        }
      ],
      "evidence": [
        {
          "id": "OQ-008-CHOICE-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-008-DATE",
      "instruction": "Supplement browser checks with server rejection of date.",
      "actions": [
        {
          "op": "request",
          "url": "/api/samples",
          "method": "POST",
          "body": {
            "sampleId": "REJECTED",
            "location": "Ambient",
            "receiptDate": "2026-02-30",
            "mass": "12",
            "volume": "3"
          },
          "as": "rejected"
        }
      ],
      "assertions": [
        {
          "id": "OQ-008-DATE-STATUS",
          "variable": "rejected.status",
          "read": "text",
          "comparison": "equals",
          "expected": 422
        },
        {
          "id": "OQ-008-DATE-ERROR",
          "variable": "rejected.body.error",
          "read": "text",
          "comparison": "equals",
          "expected": "Receipt date must be a valid calendar date."
        }
      ],
      "evidence": [
        {
          "id": "OQ-008-DATE-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-008-MISSING-VOLUME",
      "instruction": "Supplement browser checks with server rejection of missing-volume.",
      "actions": [
        {
          "op": "request",
          "url": "/api/samples",
          "method": "POST",
          "body": {
            "sampleId": "REJECTED",
            "location": "Ambient",
            "receiptDate": "2026-01-15",
            "mass": "12",
            "volume": ""
          },
          "as": "rejected"
        }
      ],
      "assertions": [
        {
          "id": "OQ-008-MISSING-VOLUME-STATUS",
          "variable": "rejected.status",
          "read": "text",
          "comparison": "equals",
          "expected": 422
        },
        {
          "id": "OQ-008-MISSING-VOLUME-ERROR",
          "variable": "rejected.body.error",
          "read": "text",
          "comparison": "equals",
          "expected": "Volume must be a number greater than zero."
        }
      ],
      "evidence": [
        {
          "id": "OQ-008-MISSING-VOLUME-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-008-MIN",
      "instruction": "Accept a one-character sample identifier.",
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
          "value": "m"
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
          "id": "OQ-008-MIN-SAVED",
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
          "id": "OQ-008-MIN-OBS",
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
