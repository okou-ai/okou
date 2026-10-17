import {
  sandboxChannelWireSchema,
  sandboxChannelHelloResultSchema,
} from "../contracts/sandbox-channel";
import {
  sandboxDiagnosticsEchoSchema,
  sandboxDiagnosticsNoticeSchema,
} from "../contracts/sandbox-channel-diagnostics";
import type { RustTypeBinding } from "./types";
import { sandboxFsTypeBindings } from "./sandbox-channel-fs-types";

export const sandboxChannelTypeBindings = [
  ...sandboxFsTypeBindings,
  {
    schema: sandboxChannelWireSchema,
    rustModulePath: ["sandbox_channel"],
    rustTypeName: "Message",
    direction: "request",
    fieldTypeOverrides: {
      params: "serde_json::Value",
      result: "serde_json::Value",
      data: "serde_json::Value",
    },
    declarations: [
      {
        rustTypeName: "Message",
        rustDoc: [
          "Opaque schema-v1 application envelope; guest-contracts validates before dispatch.",
          "Every message owns id; response requestId alone correlates a call.",
        ],
        fields: {
          schemaVersion: ["Exact common schema revision."],
          id: ["Fresh identity of this message."],
          categories: [
            "Installed current category revisions for the sending role.",
          ],
          category: ["Target business namespace."],
          categoryVersion: ["Exact target category revision."],
          operation: ["Versioned category operation name."],
          params: ["Opaque object decoded by the operation contract."],
          requestId: [
            "Identity of the answered hello/request; distinct from this response id.",
          ],
          result: ["Opaque result decoded by the captured outgoing operation."],
          error: ["Bounded safe business failure."],
          event: ["One-way category event name."],
          data: ["Opaque object decoded by the event contract."],
        },
        variants: {
          hello: ["External bootstrap."],
          request: ["Either-direction call."],
          response: ["Correlated success or error."],
          event: ["One-way notice without an implied ACK."],
        },
      },
      {
        rustTypeName: "MessageResponseError",
        rustDoc: [
          "Safe structured failure without raw paths or exception text.",
        ],
        fields: {
          code: ["Bounded error code; unknown codes are generic to consumers."],
          category: ["Optional failed category."],
          expectedVersion: ["Expected current revision when known."],
          receivedVersion: ["Received revision when valid."],
        },
      },
    ],
  },
  {
    schema: sandboxChannelHelloResultSchema,
    rustModulePath: ["sandbox_channel"],
    rustTypeName: "HelloResult",
    direction: "response",
    declarations: [
      {
        rustTypeName: "HelloResult",
        rustDoc: [
          "Installed role/category revisions for one connection epoch.",
        ],
        fields: { categories: ["Current installed role contracts."] },
      },
    ],
  },
  {
    schema: sandboxDiagnosticsEchoSchema,
    rustModulePath: ["sandbox_channel", "diagnostics"],
    rustTypeName: "Echo",
    direction: "request",
    declarations: [
      {
        rustTypeName: "Echo",
        rustDoc: [
          "Canonical bounded base64 echo request/result in either direction.",
        ],
        fields: { payload: ["Canonical padded base64 of at most 16 KiB."] },
      },
    ],
  },
  {
    schema: sandboxDiagnosticsNoticeSchema,
    rustModulePath: ["sandbox_channel", "diagnostics"],
    rustTypeName: "Notice",
    direction: "request",
    declarations: [
      {
        rustTypeName: "Notice",
        rustDoc: ["One-way diagnostic notice; no implicit response or ACK."],
        fields: { message: ["Bounded diagnostic text."] },
      },
    ],
  },
] as const satisfies readonly RustTypeBinding[];
