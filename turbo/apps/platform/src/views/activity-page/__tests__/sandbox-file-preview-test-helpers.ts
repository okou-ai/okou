import {
  entry,
  listing,
  type FilesRequest,
  type FilesReply,
} from "./sandbox-files-test-helpers.ts";

/** External Guest fixture; production Router and WSS framing remain real. */
export function previewGuest(files: Record<string, Uint8Array>) {
  const handles = new Map<string, Uint8Array>();
  let sequence = 0;
  return (request: FilesRequest): FilesReply => {
    if (request.operation === "list") {
      return listing(
        Object.keys(files).map((name) => {
          return entry(name);
        }),
      );
    }
    if (request.operation === "open") {
      const path = request.params.path;
      const token = Array.isArray(path) ? path.at(-1) : undefined;
      const name = Object.keys(files).find((candidate) => {
        return entry(candidate).nameToken === token;
      });
      const bytes = name === undefined ? undefined : files[name];
      if (!name || !bytes) {
        return { error: { code: "not_found" } };
      }
      const mode = request.params.mode;
      if (mode === "preview" && bytes.length > 16 * 1024 * 1024) {
        return { error: { code: "limit_exceeded" } };
      }
      const selected = mode === "prefix" ? bytes.slice(0, 65_536) : bytes;
      const handle = `file${++sequence}`;
      handles.set(handle, selected);
      return {
        result: {
          handle,
          nameToken: entry(name).nameToken,
          displayName: name,
          fileSize: String(bytes.length),
          selectedSize: String(selected.length),
          truncated: selected.length < bytes.length,
        },
      };
    }
    if (request.operation === "read") {
      const { handle, offset, length } = request.params;
      if (
        typeof handle !== "string" ||
        typeof offset !== "string" ||
        typeof length !== "number"
      ) {
        throw new Error("Invalid Guest read");
      }
      const bytes = handles
        .get(handle)
        ?.slice(Number(offset), Number(offset) + length);
      if (!bytes) {
        return { error: { code: "not_found" } };
      }
      return {
        result: {
          offset,
          length: bytes.length,
          data: Buffer.from(bytes).toString("base64"),
        },
      };
    }
    return { result: {} };
  };
}
