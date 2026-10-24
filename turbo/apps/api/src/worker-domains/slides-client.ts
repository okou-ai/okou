import { env } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { parsePreparationResult } from "./slides-protocol";
import type { SlidesTextStyle } from "../signals/services/google-slides-preparation";
export type { SlidesTextStyle };

interface SlidesBindings {
  readonly SLIDES_PREPARER: {
    fetch(input: string, init: RequestInit): Promise<Response>;
  };
}

/** Private service client; no Google credentials cross this boundary. */
export async function prepareGoogleSlidesImport(
  source: { readonly filename: string; readonly file: Buffer },
  signal: AbortSignal,
): Promise<
  | {
      readonly ok: true;
      readonly file: Buffer;
      readonly textStyles?: readonly SlidesTextStyle[];
    }
  | { readonly ok: false; readonly message: string }
> {
  // Keep the original fast pass-through path, including non-ZIP files.
  if (
    !/\.pptx$/iu.test(source.filename) ||
    source.file.length < 2 ||
    source.file.readUInt16LE(0) !== 0x4b_50
  ) {
    return { ok: true, file: source.file };
  }
  signal.throwIfAborted();
  const body = new FormData();
  body.set("filename", source.filename);
  body.set("file", new Blob([source.file]), "source.bin");
  const response = await (env as SlidesBindings).SLIDES_PREPARER.fetch(
    "https://slides.internal/v1/prepare",
    {
      method: "POST",
      body,
      signal,
    },
  );
  signal.throwIfAborted();
  if (!response.ok) {
    throw new Error(
      `Presentation preparation service returned HTTP ${response.status}`,
    );
  }
  const result = await response.formData();
  signal.throwIfAborted();
  const metadata = result.get("result");
  if (typeof metadata !== "string") {
    throw new Error("Presentation preparation service returned no result");
  }
  const parsed = parsePreparationResult(metadata);
  if (parsed.ok === false) {
    return { ok: false, message: parsed.message };
  }
  const file = result.get("file");
  if (parsed.ok !== true || !(file instanceof Blob)) {
    throw new Error(
      "Presentation preparation service returned an invalid result",
    );
  }
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  return {
    ok: true,
    file: Buffer.from(bytes),
    ...(parsed.textStyles === undefined
      ? {}
      : { textStyles: parsed.textStyles }),
  };
}
