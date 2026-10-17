import {
  sandboxFsReadOpenParamsSchema,
  sandboxFsReadOpenResultSchema,
  sandboxFsReadParamsSchema,
  sandboxFsReadResultSchema,
  sandboxFsReadHandleParamsSchema,
  sandboxFsReadReleaseResultSchema,
} from "../contracts/sandbox-channel-fs";
import type { RustTypeBinding } from "./types";

export const sandboxFsReadTypeBindings = [
  {
    schema: sandboxFsReadOpenParamsSchema,
    rustModulePath: ["sandbox_channel", "fs_read"],
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
    schema: sandboxFsReadOpenResultSchema,
    rustModulePath: ["sandbox_channel", "fs_read"],
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
    rustModulePath: ["sandbox_channel", "fs_read"],
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
    rustModulePath: ["sandbox_channel", "fs_read"],
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
    schema: sandboxFsReadHandleParamsSchema,
    rustModulePath: ["sandbox_channel", "fs_read"],
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
    schema: sandboxFsReadReleaseResultSchema,
    rustModulePath: ["sandbox_channel", "fs_read"],
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
