import type { core } from "zod";

// Exact published runtime-api-schema-prod 200 response, retrieved 2026-10-15.
export const previousCommandClaimJsonSchema: core.JSONSchema.JSONSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  oneOf: [
    {
      additionalProperties: false,
      properties: {
        status: {
          const: "idle",
          type: "string",
        },
      },
      required: ["status"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        command: {
          additionalProperties: false,
          properties: {
            claimedAt: {
              type: ["string", "null"],
            },
            completedAt: {
              type: ["string", "null"],
            },
            createdAt: {
              type: "string",
            },
            error: {
              additionalProperties: false,
              properties: {
                code: {
                  enum: [
                    "no_host",
                    "permission_denied",
                    "accessibility_unavailable",
                    "automation_permission_denied",
                    "window_unavailable",
                    "screen_recording_unavailable",
                    "app_not_found",
                    "app_open_failed",
                    "element_action_unsupported",
                    "element_not_editable",
                    "unsupported_command",
                    "timeout",
                    "command_timeout",
                    "invalid_arguments",
                    "result_too_large",
                  ],
                  type: "string",
                },
                message: {
                  type: "string",
                },
              },
              required: ["code", "message"],
              type: "object",
            },
            hostId: {
              type: ["string", "null"],
            },
            hostName: {
              type: ["string", "null"],
            },
            id: {
              type: "string",
            },
            kind: {
              enum: [
                "apps.list",
                "app.state",
                "app.open",
                "element.click",
                "element.scroll",
                "element.set_value",
                "element.perform_action",
                "keyboard.type_text",
                "keyboard.press_key",
              ],
              type: "string",
            },
            payload: {
              additionalProperties: {},
              propertyNames: {
                type: "string",
              },
              type: "object",
            },
            result: {
              additionalProperties: {},
              propertyNames: {
                type: "string",
              },
              type: "object",
            },
            status: {
              enum: ["queued", "running", "succeeded", "failed"],
              type: "string",
            },
            timeoutMs: {
              anyOf: [
                {
                  maximum: 9007199254740991,
                  minimum: -9007199254740991,
                  type: "integer",
                },
                {
                  type: "null",
                },
              ],
            },
          },
          required: [
            "id",
            "kind",
            "status",
            "hostId",
            "hostName",
            "payload",
            "timeoutMs",
            "createdAt",
            "claimedAt",
            "completedAt",
          ],
          type: "object",
        },
        status: {
          const: "command",
          type: "string",
        },
      },
      required: ["status", "command"],
      type: "object",
    },
  ],
};
