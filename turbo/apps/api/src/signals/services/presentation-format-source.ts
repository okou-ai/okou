import type {
  GenerationTemplateRequest,
  UserMessageDocument,
  UserMessagePart,
} from "@okouai/api-contracts/contracts/chat-threads";
import { isChatRunReference } from "@okouai/api-contracts/contracts/chat-run-reference";
import type { PresentationOutputFormat } from "@okouai/core/presentation-output-format";
import { parseUserPresentationTemplateId } from "@okouai/core/presentation-template-selection";
import { withPresentationTemplateFormat } from "@okouai/core/presentation-template-format";

type Assembly =
  | { readonly ok: true; readonly userMessage: UserMessageDocument }
  | { readonly ok: false; readonly message: string };

function collectPresentationTemplates(
  documents: readonly UserMessageDocument[],
) {
  const templates = new Map<string, GenerationTemplateRequest>();
  for (const document of documents) {
    for (const part of document.parts) {
      const candidates = part.type === "feedback" ? part.note : [part];
      for (const candidate of candidates) {
        if (candidate.type === "template") {
          templates.set(JSON.stringify(candidate.template), candidate.template);
        }
      }
    }
  }
  return templates;
}

function rewritePresentationTemplate(
  selected: GenerationTemplateRequest | undefined,
  presentationFormat: PresentationOutputFormat,
):
  | {
      readonly ok: true;
      readonly template: GenerationTemplateRequest | undefined;
    }
  | { readonly ok: false; readonly message: string } {
  if (selected?.type !== "presentation") {
    return { ok: true, template: undefined };
  }
  // Imported presentation packages currently author HTML, not native PPTX.
  if (parseUserPresentationTemplateId(selected.selection.templateId)) {
    if (presentationFormat !== "html") {
      return {
        ok: false,
        message:
          "This imported presentation template supports HTML only. Choose HTML or a native PPTX template.",
      };
    }
    return {
      ok: true,
      template: {
        ...selected,
        selection: { ...selected.selection, outputFormat: presentationFormat },
      },
    };
  }
  const selection = withPresentationTemplateFormat(
    selected.selection,
    presentationFormat,
  );
  if (!selection) {
    return {
      ok: false,
      message:
        "The selected template does not support this presentation format.",
    };
  }
  return { ok: true, template: { ...selected, selection } };
}

/** Only the consumed, canonical task inputs cross into the new normal send. */
export function reconstructPresentationTask(
  documents: readonly UserMessageDocument[],
  presentationFormat: PresentationOutputFormat,
): Assembly {
  const templates = collectPresentationTemplates(documents);
  if (templates.size > 1) {
    return {
      ok: false,
      message:
        "The source contains multiple template selections. Restate the unfinished presentation with one template.",
    };
  }
  const selected = [...templates.values()][0];
  if (selected && selected.type !== "presentation") {
    return {
      ok: false,
      message:
        "The source template does not declare a compatible presentation output format. Select a compatible presentation template first.",
    };
  }
  if (
    documents.length > 1 &&
    !documents.every((document) => {
      return document.parts.some((part) => {
        return (
          (part.type === "template" && part.template.type === "presentation") ||
          (part.type === "additional_info" &&
            /(?:^Create a presentation\.|^# Presentation Generation Defaults$)/mu.test(
              part.text,
            ))
        );
      });
    })
  ) {
    return {
      ok: false,
      message:
        "The source consumed multiple requests whose presentation context is ambiguous. Restate only the unfinished presentation.",
    };
  }
  const rewritten = rewritePresentationTemplate(selected, presentationFormat);
  if (!rewritten.ok) {
    return rewritten;
  }
  const rewrittenTemplate = rewritten.template;
  const parts: UserMessagePart[] = [];
  for (const document of documents) {
    for (const part of document.parts) {
      if (
        part.type === "source" ||
        part.type === "model" ||
        part.type === "automation" ||
        part.type === "presentation_format_selection" ||
        isChatRunReference(part)
      ) {
        continue;
      }
      if (part.type === "template" && rewrittenTemplate) {
        parts.push({ ...part, template: rewrittenTemplate });
      } else if (part.type === "feedback" && rewrittenTemplate) {
        const template = rewrittenTemplate;
        parts.push({
          ...part,
          note: part.note.map((note) => {
            return note.type === "template" ? { ...note, template } : note;
          }),
        });
      } else if (part.type === "additional_info") {
        // Preserve slide count and task context, but not an obsolete composer format.
        const text = part.text
          .replace(
            /^- Output format: (?:HTML|PPTX) format$/gmu,
            `- Output format: ${presentationFormat.toUpperCase()} format`,
          )
          .replace(
            /okou generate presentation --format (?:html|pptx)/gu,
            `okou generate presentation --format ${presentationFormat}`,
          )
          .replace(
            /\((?:HTML|PPTX) format\)/gu,
            `(${presentationFormat.toUpperCase()} format)`,
          );
        parts.push({ ...part, text });
      } else {
        parts.push(part);
      }
    }
    parts.push({ type: "text", text: "\n\n" });
  }
  parts.push({
    type: "text",
    text: `Continue only the unfinished presentation from the original request above, using ${presentationFormat.toUpperCase()}. Preserve its content, language, slide count, references and selected style. Do not repeat completed work or any unrelated operation. The confirmed format replaces prior presentation-format defaults for this task only.`,
  });
  return { ok: true, userMessage: { version: 1, parts } };
}
