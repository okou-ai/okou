import { accept } from "@okouai/connectors/accept";
import { create, type Font } from "fontkit";
import { settleIncludingAbort } from "../utils";

export interface SlidesFontFace {
  readonly family: string;
  readonly weight: number;
  readonly italic: boolean;
}

/** PowerPoint often stores the style as part of the family name. */
export function slidesFontFace(
  typeface: string,
  bold: boolean,
  italic: boolean,
): SlidesFontFace | undefined {
  if (!/^[\p{L}\p{N} ._-]{1,128}$/u.test(typeface)) {
    return undefined;
  }
  const styles: Readonly<Record<string, number>> = {
    thin: 100,
    extralight: 200,
    light: 300,
    regular: 400,
    medium: 500,
    semibold: 600,
    demibold: 600,
    bold: 700,
    extrabold: 800,
    black: 900,
  };
  const match =
    /\s+(Thin|ExtraLight|Light|Regular|Medium|SemiBold|DemiBold|Bold|ExtraBold|Black)$/iu.exec(
      typeface,
    );
  const weight = match ? styles[match[1]!.toLowerCase()]! : 400;
  return {
    family: match ? typeface.slice(0, match.index) : typeface,
    weight: bold ? Math.max(700, weight) : weight,
    italic,
  };
}

async function boundedBody(
  response: Response,
  maximum: number,
): Promise<Buffer> {
  if (!response.body) {
    throw new Error("Google Fonts returned an empty body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const read = async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        return Buffer.concat(chunks);
      }
      size += chunk.value.byteLength;
      if (size > maximum) {
        throw new Error("Google Fonts response exceeds the import limit");
      }
      chunks.push(chunk.value);
    }
  };
  const result = await settleIncludingAbort(read());
  await reader.cancel();
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/** Fetch public font data, never document text or caller-supplied font URLs. */
export async function loadSlidesFont(
  face: SlidesFontFace,
  _signal: AbortSignal,
): Promise<Font | undefined> {
  const url = new URL("https://fonts.googleapis.com/css2");
  const variant = face.italic
    ? `ital,wght@1,${String(face.weight)}`
    : `wght@${String(face.weight)}`;
  url.searchParams.set("family", `${face.family}:${variant}`);
  const css = await accept(
    fetch(url, {
      // The legacy stylesheet serves a complete static TrueType face instead
      // of browser-specific Unicode subsets or a variable-font default weight.
      headers: { "User-Agent": "Okou-Presentation-Import/1.0" },
    }),
    [200, 400],
  );
  const stylesheet = (await boundedBody(css, 256 * 1024)).toString("utf8");
  // A missing family/style is an expected catalog miss. Do not substitute a
  // different font, and do not treat outages or rate limits as catalog misses.
  if (css.status === 400) {
    return undefined;
  }
  const sources = [
    ...stylesheet.matchAll(
      /url\((https:\/\/fonts\.gstatic\.com\/[^\s)'"<>]+)\)\s+format\(['"]truetype['"]\)/gu,
    ),
  ];
  if (sources.length !== 1) {
    return undefined;
  }
  const fontUrl = new URL(sources[0]![1]!);
  if (fontUrl.origin !== "https://fonts.gstatic.com") {
    return undefined;
  }
  const response = await accept(fetch(fontUrl), [200]);
  const font = create(await boundedBody(response, 8 * 1024 * 1024));
  return "glyphForCodePoint" in font ? font : undefined;
}
