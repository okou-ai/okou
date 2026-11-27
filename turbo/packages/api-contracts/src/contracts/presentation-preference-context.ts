import { object, type infer as zInfer } from "zod";
import { presentationOutputFormatSchema } from "../validators/presentation-output-format";
import type { UserMessageDocument, UserMessagePart } from "./chat-threads";

const NAMESPACE = "Okou presentation preference ";
const PREFIX = `${NAMESPACE}v1:\n`;
const LEGACY_HEADER = "# Presentation Output Preference";
const contextSchema = object({
  format: presentationOutputFormatSchema.nullable(),
}).strict();

export type PresentationPreferenceContext = zInfer<typeof contextSchema>;

export function presentationPreferenceContextPart(
  context: PresentationPreferenceContext,
): Extract<UserMessagePart, { type: "additional_info" }> {
  return {
    type: "additional_info",
    text: PREFIX + JSON.stringify(contextSchema.parse(context)),
  };
}

export function isPresentationPreferenceContext(
  part: UserMessagePart,
): boolean {
  return part.type === "additional_info" && part.text.startsWith(NAMESPACE);
}

/** A reserved context is never ordinary executable additional information. */
export function readPresentationPreferenceContext(
  document: UserMessageDocument,
): PresentationPreferenceContext | undefined {
  let context: PresentationPreferenceContext | undefined;
  for (const part of document.parts) {
    if (!isPresentationPreferenceContext(part)) {
      continue;
    }
    if (part.type !== "additional_info" || !part.text.startsWith(PREFIX)) {
      throw new Error("Unsupported presentation preference context version");
    }
    if (context !== undefined) {
      throw new Error("Multiple presentation preference contexts");
    }
    const value: unknown = JSON.parse(part.text.slice(PREFIX.length));
    context = contextSchema.parse(value);
  }
  return context;
}

/** New inputs must not inherit a copied message's saved-default annotation. */
export function withoutPresentationPreferenceContext<
  Part extends UserMessagePart,
>(document: {
  readonly version: 1;
  readonly parts: readonly Part[];
}): { readonly version: 1; readonly parts: Part[] } {
  return {
    version: document.version,
    parts: document.parts.flatMap((part): Part[] => {
      if (isPresentationPreferenceContext(part)) {
        return [];
      }
      if (part.type !== "additional_info") {
        return [part];
      }
      // Only this platform-owned section is a saved default. Other composer
      // sections describe the user's current task and must retain their order.
      const sections = part.text.split(/(?=^# )/mu);
      const retained = sections.filter((section) => {
        return (
          section !== LEGACY_HEADER &&
          !section.startsWith(`${LEGACY_HEADER}\n`) &&
          !section.startsWith(`${LEGACY_HEADER}\r\n`)
        );
      });
      if (retained.length === sections.length) {
        return [part];
      }
      const text = retained.join("").trim();
      if (text.length === 0) {
        return [];
      }
      return [text === part.text ? part : { ...part, text }];
    }),
  };
}
