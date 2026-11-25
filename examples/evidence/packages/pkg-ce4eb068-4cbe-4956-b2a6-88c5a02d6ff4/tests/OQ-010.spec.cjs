// Generated from plan PLAN-SAMPLE-REGISTER. Edit the candidate plan, then regenerate.
'use strict';
module.exports = function register({ test, runtime }) {
  test("OQ-010 Attachment contents and rejection", async () => {
    await runtime.executeCase("OQ-010", {
  "id": "OQ-010",
  "title": "Attachment contents and rejection",
  "classification": "OQ",
  "requirements": [
    "URS-FILE-001"
  ],
  "actor": "operator",
  "prerequisites": [
    "Qualification starts with an empty synthetic sample data directory. This case uses distinct identifiers."
  ],
  "manual": false,
  "steps": [
    {
      "id": "OQ-010-LOGIN",
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
          "id": "OQ-010-AUTH",
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
          "id": "OQ-010-LOGIN-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-010-1",
      "instruction": "Upload and inspect the retained synthetic plain-text attachment.",
      "actions": [
        {
          "op": "navigate",
          "url": "/attachments"
        },
        {
          "op": "upload",
          "locator": {
            "by": "label",
            "value": "Text attachment",
            "exact": true
          },
          "path": "fixtures/sample-notes.txt"
        },
        {
          "op": "click",
          "locator": {
            "by": "role",
            "value": "Upload attachment",
            "role": "button",
            "exact": true
          }
        }
      ],
      "assertions": [
        {
          "id": "OQ-010-NAME",
          "locator": {
            "by": "css",
            "value": "[role=\"status\"]",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "Attachment received: sample-notes.txt"
        },
        {
          "id": "OQ-010-TEXT",
          "locator": {
            "by": "testId",
            "value": "attachment-content",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "Synthetic receipt attachment.\nNo personal or patient data.\n"
        }
      ],
      "evidence": [
        {
          "id": "OQ-010-1-OBS",
          "kind": "observation",
          "required": true
        },
        {
          "id": "OQ-010-1-SCREEN",
          "kind": "screenshot",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-010-EXT",
      "instruction": "Reject an unsupported or oversized attachment.",
      "actions": [
        {
          "op": "navigate",
          "url": "/attachments"
        },
        {
          "op": "upload",
          "locator": {
            "by": "label",
            "value": "Text attachment",
            "exact": true
          },
          "path": "fixtures/not-text.csv"
        },
        {
          "op": "click",
          "locator": {
            "by": "role",
            "value": "Upload attachment",
            "role": "button",
            "exact": true
          }
        }
      ],
      "assertions": [
        {
          "id": "OQ-010-EXT-ERROR",
          "locator": {
            "by": "css",
            "value": "[role=\"alert\"]",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "A plain-text .txt attachment of at most 100 KiB is required."
        }
      ],
      "evidence": [
        {
          "id": "OQ-010-EXT-OBS",
          "kind": "observation",
          "required": true
        }
      ]
    },
    {
      "id": "OQ-010-SIZE",
      "instruction": "Reject an unsupported or oversized attachment.",
      "actions": [
        {
          "op": "navigate",
          "url": "/attachments"
        },
        {
          "op": "upload",
          "locator": {
            "by": "label",
            "value": "Text attachment",
            "exact": true
          },
          "path": "fixtures/too-large.txt"
        },
        {
          "op": "click",
          "locator": {
            "by": "role",
            "value": "Upload attachment",
            "role": "button",
            "exact": true
          }
        }
      ],
      "assertions": [
        {
          "id": "OQ-010-SIZE-ERROR",
          "locator": {
            "by": "css",
            "value": "[role=\"alert\"]",
            "exact": true
          },
          "read": "text",
          "comparison": "equals",
          "expected": "A plain-text .txt attachment of at most 100 KiB is required."
        }
      ],
      "evidence": [
        {
          "id": "OQ-010-SIZE-OBS",
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
