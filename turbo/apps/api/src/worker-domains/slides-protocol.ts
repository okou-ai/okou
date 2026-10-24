import type { SlidesTextStyle } from "../signals/services/google-slides-preparation";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textStyle(value: unknown): value is SlidesTextStyle {
  if (
    !object(value) ||
    !Number.isSafeInteger(value.page) ||
    typeof value.shapeId !== "string" ||
    typeof value.text !== "string"
  ) {
    return false;
  }
  const bounds = value.bounds;
  if (
    !object(bounds) ||
    !["x", "y", "width", "height"].every((key) => {
      return typeof bounds[key] === "number" && Number.isFinite(bounds[key]);
    })
  ) {
    return false;
  }
  return (
    Array.isArray(value.runs) &&
    value.runs.every((run) => {
      return (
        object(run) &&
        typeof run.text === "string" &&
        object(run.face) &&
        typeof run.face.family === "string" &&
        typeof run.face.weight === "number" &&
        Number.isFinite(run.face.weight) &&
        typeof run.face.italic === "boolean"
      );
    })
  );
}

export function parsePreparationResult(
  text: string,
):
  | { readonly ok: true; readonly textStyles?: readonly SlidesTextStyle[] }
  | { readonly ok: false; readonly message: string } {
  const parsed: unknown = JSON.parse(text);
  if (object(parsed)) {
    if (parsed.ok === false && typeof parsed.message === "string") {
      return { ok: false, message: parsed.message };
    }
    if (
      parsed.ok === true &&
      (parsed.textStyles === undefined ||
        (Array.isArray(parsed.textStyles) &&
          parsed.textStyles.every(textStyle)))
    ) {
      return {
        ok: true,
        ...(parsed.textStyles === undefined
          ? {}
          : { textStyles: parsed.textStyles }),
      };
    }
  }
  throw new Error(
    "Presentation preparation service returned an invalid result",
  );
}
