import { settle } from "../utils";
import { accept, HttpStatusError } from "@okouai/connectors/accept";
import {
  array,
  boolean,
  number,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import type { SlidesTextStyle } from "./google-slides-import.service";

const PRESENTATIONS = "https://slides.googleapis.com/v1/presentations";
const dimension = object({
  magnitude: number(),
  unit: zEnum(["EMU", "PT"]),
});
const textStyle = object({
  weightedFontFamily: object({
    fontFamily: string(),
    weight: number().optional(),
  }).optional(),
  fontFamily: string().optional(),
  bold: boolean().optional(),
  italic: boolean().optional(),
});
const elementSchema = object({
  objectId: string(),
  size: object({ width: dimension, height: dimension }).optional(),
  transform: object({
    scaleX: number().optional(),
    scaleY: number().optional(),
    shearX: number().optional(),
    shearY: number().optional(),
    translateX: number().optional(),
    translateY: number().optional(),
    unit: zEnum(["EMU", "PT"]),
  }).optional(),
  shape: object({
    text: object({
      textElements: array(
        object({
          startIndex: number().optional(),
          endIndex: number().optional(),
          textRun: object({
            content: string(),
            style: textStyle.optional(),
          }).optional(),
        }),
      ).optional(),
    }).optional(),
  }).optional(),
});
const presentationSchema = object({
  revisionId: string(),
  slides: array(object({ pageElements: array(elementSchema).optional() })),
});
type Element = zInfer<typeof elementSchema>;

function content(element: Element): string {
  return (element.shape?.text?.textElements ?? [])
    .map((run) => {
      return run.textRun?.content ?? "";
    })
    .join("")
    .replace(/\n$/u, "");
}
function position(element: Element) {
  const { size, transform: t } = element;
  if (
    !size ||
    !t ||
    (t.shearX ?? 0) !== 0 ||
    (t.shearY ?? 0) !== 0 ||
    (t.scaleX ?? 0) <= 0 ||
    (t.scaleY ?? 0) <= 0
  ) {
    return undefined;
  }
  const units = t.unit === "PT" ? 12_700 : 1;
  return {
    x: (t.translateX ?? 0) * units,
    y: (t.translateY ?? 0) * units,
    width:
      size.width.magnitude *
      (size.width.unit === "PT" ? 12_700 : 1) *
      (t.scaleX ?? 0),
    height:
      size.height.magnitude *
      (size.height.unit === "PT" ? 12_700 : 1) *
      (t.scaleY ?? 0),
  };
}
function matches(element: Element, expected: SlidesTextStyle): boolean {
  const box = position(element);
  return (
    content(element) === expected.text &&
    !!box &&
    (Object.keys(box) as (keyof typeof box)[]).every((key) => {
      return Math.abs(box[key] - expected.bounds[key]) <= 12_700;
    })
  );
}

function faceMatches(
  style: zInfer<typeof textStyle> | undefined,
  face: SlidesTextStyle["runs"][number]["face"],
): boolean {
  const family = style?.weightedFontFamily?.fontFamily ?? style?.fontFamily;
  const weight = style?.weightedFontFamily?.weight ?? (style?.bold ? 700 : 400);
  return (
    family === face.family &&
    weight === face.weight &&
    (style?.bold ?? false) === face.weight >= 700 &&
    (style?.italic ?? false) === face.italic
  );
}

function stylesMatch(element: Element, source: SlidesTextStyle): boolean {
  let start = 0;
  for (const run of source.runs) {
    const end = start + run.text.length;
    const segments = (element.shape?.text?.textElements ?? []).filter(
      (part) => {
        return (
          part.textRun &&
          (part.endIndex ?? 0) > start &&
          (part.startIndex ?? 0) < end
        );
      },
    );
    let covered = start;
    for (const part of segments) {
      if (
        (part.startIndex ?? 0) > covered ||
        !faceMatches(part.textRun!.style, run.face)
      ) {
        return false;
      }
      covered = Math.max(covered, Math.min(end, part.endIndex ?? 0));
    }
    if (covered !== end) {
      return false;
    }
    start = end;
  }
  return true;
}

/** Match by page, text and geometry; PPTX ids are not Google object ids. */
export async function applyGoogleSlidesTextStyles(
  accessToken: string,
  presentationId: string,
  expected: readonly SlidesTextStyle[],
  _signal: AbortSignal,
): Promise<string | undefined> {
  if (!expected.length) {
    return undefined;
  }
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  const url = `${PRESENTATIONS}/${encodeURIComponent(presentationId)}`;
  const read = async () => {
    const acceptedResponse = await settle(
      accept(fetch(url, { headers }), [200]),
    );
    let response: Response;
    if (acceptedResponse.ok) {
      response = acceptedResponse.value;
    } else if (
      acceptedResponse.error instanceof HttpStatusError &&
      acceptedResponse.error.status >= 300
    ) {
      response = acceptedResponse.error.response;
    } else {
      throw acceptedResponse.error;
    }
    if (!response.ok) {
      return undefined;
    }
    const parsed = presentationSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : undefined;
  };
  const before = await read();
  if (!before) {
    return "Google Slides could not verify the imported text before restoring its fonts. Check the uploaded copy before retrying.";
  }
  const assigned = new Set<string>();
  const targets: { objectId: string; source: SlidesTextStyle }[] = [];
  for (const source of expected) {
    const candidates = (before.slides[source.page]?.pageElements ?? []).filter(
      (element) => {
        return matches(element, source);
      },
    );
    if (candidates.length !== 1 || assigned.has(candidates[0]!.objectId)) {
      return "Google Slides changed the imported text or its geometry. Font restoration stopped to preserve the uploaded copy.";
    }
    const objectId = candidates[0]!.objectId;
    assigned.add(objectId);
    targets.push({ objectId, source });
  }
  const requests = targets.flatMap(({ objectId, source }) => {
    let index = 0;
    return source.runs.map((run) => {
      const startIndex = index;
      index += run.text.length;
      return {
        updateTextStyle: {
          objectId,
          textRange: { type: "FIXED_RANGE", startIndex, endIndex: index },
          style: {
            weightedFontFamily: {
              fontFamily: run.face.family,
              weight: run.face.weight,
            },
            bold: run.face.weight >= 700,
            italic: run.face.italic,
          },
          fields: "weightedFontFamily,bold,italic",
        },
      };
    });
  });
  // A single atomic batch guarded by the read revision cannot overwrite edits
  // made between identity matching and the style write.
  const acceptedResponse2 = await settle(
    accept(
      fetch(`${url}:batchUpdate`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          requests,
          writeControl: { requiredRevisionId: before.revisionId },
        }),
      }),
      [200],
    ),
  );
  let response: Response;
  if (acceptedResponse2.ok) {
    response = acceptedResponse2.value;
  } else if (
    acceptedResponse2.error instanceof HttpStatusError &&
    acceptedResponse2.error.status >= 300
  ) {
    response = acceptedResponse2.error.response;
  } else {
    throw acceptedResponse2.error;
  }
  if (!response.ok) {
    return "Google Slides could not restore the imported font styles. Check the uploaded copy before retrying.";
  }
  const after = await read();
  if (!after) {
    return "Google Slides font restoration could not be verified. Check the uploaded copy before retrying.";
  }
  for (const { objectId, source } of targets) {
    const element = after.slides[source.page]?.pageElements?.find((item) => {
      return item.objectId === objectId;
    });
    if (!element || !matches(element, source)) {
      return "Google Slides changed the imported text during font restoration.";
    }
    if (!stylesMatch(element, source)) {
      return "Google Slides did not retain all requested font styles. Check the uploaded copy before retrying.";
    }
  }
  return undefined;
}
