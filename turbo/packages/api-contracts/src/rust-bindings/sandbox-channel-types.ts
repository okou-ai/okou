import {
  sandboxChannelWireSchema,
  sandboxChannelHelloResultSchema,
} from "../contracts/sandbox-channel";
import {
  sandboxFsListParamsSchema,
  sandboxFsListResultSchema,
  sandboxFsListCloseParamsSchema,
  sandboxFsListCloseResultSchema,
} from "../contracts/sandbox-channel-fs";
import {
  sandboxDiagnosticsEchoSchema,
  sandboxDiagnosticsNoticeSchema,
} from "../contracts/sandbox-channel-diagnostics";
import type { RustTypeBinding } from "./types";
import { sandboxFsReadTypeBindings } from "./sandbox-channel-fs-read-types";

export const sandboxChannelTypeBindings = [
  ...sandboxFsReadTypeBindings,
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
    schema: sandboxFsListParamsSchema,
    rustModulePath: ["sandbox_channel", "fs"],
    rustTypeName: "ListParams",
    direction: "request",
    declarations: [
      {
        rustTypeName: "ListParams",
        rustDoc: ["Exactly one relative raw-name path or owned continuation."],
        fields: {
          path: ["Canonical raw basename tokens relative to home."],
          cursor: ["This connection's opaque continuation."],
        },
      },
    ],
  },
  {
    schema: sandboxFsListResultSchema,
    rustModulePath: ["sandbox_channel", "fs"],
    rustTypeName: "ListResult",
    direction: "response",
    declarations: [
      {
        rustTypeName: "ListResult",
        rustDoc: [
          "One bounded directory page; null continuation denotes actual EOF.",
        ],
        fields: {
          listingId: ["This enumeration's independent identity."],
          entries: ["Bounded readonly metadata."],
          nextCursor: ["Continuation, or null at actual EOF."],
        },
      },
      {
        rustTypeName: "ListResultEntrie",
        rustDoc: ["One raw basename and safe display label."],
        fields: {
          nameToken: ["Canonical raw basename bytes."],
          displayName: ["Safe text label, never a path input."],
          kind: ["Readonly entry presentation kind."],
        },
      },
      {
        rustTypeName: "ListResultEntrieKind",
        rustDoc: ["Readonly entry kinds."],
        variants: {
          directory: ["Expandable directory within policy."],
          file: ["Ordinary file metadata."],
          symlink: ["Displayed without target traversal."],
          other: ["Special entry metadata only."],
        },
      },
    ],
  },
  {
    schema: sandboxFsListCloseParamsSchema,
    rustModulePath: ["sandbox_channel", "fs"],
    rustTypeName: "ListCloseParams",
    direction: "request",
    declarations: [
      {
        rustTypeName: "ListCloseParams",
        rustDoc: ["Release this connection's directory continuation."],
        fields: { cursor: ["Owned continuation to release."] },
      },
    ],
  },
  {
    schema: sandboxFsListCloseResultSchema,
    rustModulePath: ["sandbox_channel", "fs"],
    rustTypeName: "ListCloseResult",
    direction: "response",
    declarations: [
      {
        rustTypeName: "ListCloseResult",
        rustDoc: ["Successful bounded cursor release."],
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
