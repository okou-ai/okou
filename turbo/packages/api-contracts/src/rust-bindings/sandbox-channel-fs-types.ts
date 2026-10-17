import {
  sandboxFsListParamsSchema,
  sandboxFsListResultSchema,
  sandboxFsListCloseParamsSchema,
  sandboxFsListCloseResultSchema,
  sandboxFsOpenParamsSchema,
  sandboxFsOpenResultSchema,
  sandboxFsReadParamsSchema,
  sandboxFsReadResultSchema,
  sandboxFsHandleParamsSchema,
  sandboxFsReleaseResultSchema,
} from "../contracts/sandbox-channel-fs";
import type { RustTypeBinding } from "./types";

export const sandboxFsTypeBindings = [
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
          path: ["Canonical raw basename tokens relative to Guest root."],
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
    schema: sandboxFsOpenParamsSchema,
    rustModulePath: ["sandbox_channel", "fs"],
    rustTypeName: "OpenParams",
    direction: "request",
    declarations: [
      {
        rustTypeName: "OpenParams",
        rustDoc: [
          "Open an owned regular-file reader with an explicit selection policy.",
        ],
        fields: {
          path: [
            "Nonempty raw basename tokens relative to captured Guest root.",
          ],
          mode: ["Complete download or bounded preview selection."],
        },
      },
      {
        rustTypeName: "OpenParamsMode",
        rustDoc: ["Preview caps never gate complete downloads."],
        variants: {
          download: ["Complete file, without a product byte cap."],
          preview: ["Complete file within the preview bound."],
          prefix: ["Bounded text prefix with explicit truncation."],
        },
      },
    ],
  },
  {
    schema: sandboxFsOpenResultSchema,
    rustModulePath: ["sandbox_channel", "fs"],
    rustTypeName: "OpenResult",
    direction: "response",
    declarations: [
      {
        rustTypeName: "OpenResult",
        rustDoc: ["Held regular-file identity and exact selected byte range."],
        fields: {
          handle: ["Opaque connection-owned reader handle."],
          nameToken: [
            "Canonical raw basename, independent of the display label.",
          ],
          displayName: ["Safe display label, never a path input."],
          fileSize: [
            "Complete size as a canonical native-offset decimal string.",
          ],
          selectedSize: [
            "Selected bytes as a canonical native-offset decimal string.",
          ],
          truncated: ["Whether the selected range is shorter than the file."],
        },
      },
    ],
  },
  {
    schema: sandboxFsReadParamsSchema,
    rustModulePath: ["sandbox_channel", "fs"],
    rustTypeName: "ReadParams",
    direction: "request",
    declarations: [
      {
        rustTypeName: "ReadParams",
        rustDoc: ["One bounded positional read from an owned handle."],
        fields: {
          handle: ["Owned regular-file handle."],
          offset: ["Exact canonical decimal offset within the selected range."],
          length: ["Positive requested raw bytes within the chunk bound."],
        },
      },
    ],
  },
  {
    schema: sandboxFsReadResultSchema,
    rustModulePath: ["sandbox_channel", "fs"],
    rustTypeName: "ReadResult",
    direction: "response",
    declarations: [
      {
        rustTypeName: "ReadResult",
        rustDoc: [
          "Exact offset and canonical padded base64 of one validated chunk.",
        ],
        fields: {
          offset: ["Canonical decimal offset matching the request."],
          length: ["Actual raw byte count; zero only at selected EOF."],
          data: ["Canonical padded base64 of exactly length raw bytes."],
        },
      },
    ],
  },
  {
    schema: sandboxFsHandleParamsSchema,
    rustModulePath: ["sandbox_channel", "fs"],
    rustTypeName: "HandleParams",
    direction: "request",
    declarations: [
      {
        rustTypeName: "HandleParams",
        rustDoc: ["Finish validation or explicitly abandon this reader."],
        fields: { handle: ["Opaque connection-owned reader handle."] },
      },
    ],
  },
  {
    schema: sandboxFsReleaseResultSchema,
    rustModulePath: ["sandbox_channel", "fs"],
    rustTypeName: "ReleaseResult",
    direction: "response",
    declarations: [
      {
        rustTypeName: "ReleaseResult",
        rustDoc: [
          "Successful reader release; finish also validates observed stability.",
        ],
      },
    ],
  },
] as const satisfies readonly RustTypeBinding[];
