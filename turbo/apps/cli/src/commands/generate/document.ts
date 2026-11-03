import { Command } from "commander";
import {
  DOCUMENT_TEMPLATE_ITEMS,
  findDocumentTemplateItem,
} from "@okouai/core/document-template-items";
import { documentTemplateInstructionLines } from "@okouai/core/document-generation-instructions";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  createArtifactVisibilityOption,
  type ArtifactVisibility,
} from "../shared/artifact-visibility";
import { dispatchGenerate } from "./lib/dispatch";
import { runLister } from "./lib/lister";

interface DocumentOptions {
  readonly prompt?: string;
  readonly template?: string;
  readonly provider?: string;
  readonly all?: boolean;
  readonly visibility?: ArtifactVisibility;
}

function documentChoices(): string {
  return [
    "Default:",
    "  default — Author from a blank document when no built-in template fits.",
    "",
    "Built-in Document templates:",
    ...DOCUMENT_TEMPLATE_ITEMS.map((item) => {
      return `  ${item.id} — ${item.title} (${item.category})\n    ${item.description}`;
    }),
  ].join("\n");
}

export function createDocumentCommand(): Command {
  return new Command()
    .name("document")
    .description("Prepare default or built-in template document authoring")
    .option("--prompt <text>", "Document prompt; can also be piped via stdin")
    .option(
      "--template <id>",
      "Use 'default', a built-in id, or a catalog slug; omit for agent selection",
    )
    .option(
      "--provider <name>",
      "Use built-in authoring or print a connector's skill-invocation guidance",
    )
    .option("--all", "Also discover connector-backed document providers")
    .addOption(createArtifactVisibilityOption())
    .addHelpText("after", () => {
      return `
Examples:
  Choose automatically: okou generate document --prompt "Create a sales follow-up guide as DOCX"
  Use Default:          okou generate document --template default --prompt "Create a sales handbook"
  Use a template:       okou generate document --template monthly-services --prompt "Draft a monthly service agreement"
  Show choices:         okou generate document
  Show connectors too:  okou generate document --all
  Use a connector:      okou generate document --provider <connector>

Output:
  Prints authoring instructions for the calling agent, not a completed document.
  With no prompt, lists Default and built-in templates without network access.

Notes:
  - Without --template, choose a suitable built-in template or Default; do not force an unrelated template.
  - Honor attached or explicitly named templates and the requested output format.
  - 'default' means blank-document authoring, not a default file format.
  - Built-in templates use the same catalog and pinned originals as the Document picker.
  - --template accepts 'monthly-services', 'document-template:monthly-services', or 'document-monthly-services'.
  - Connector guidance remains available through --provider or --all.

${documentChoices()}`;
    })
    .action(
      withErrorHandler(async (options: DocumentOptions) => {
        const templateId = options.template?.trim();
        const provider = options.provider?.trim();
        if (templateId !== undefined && provider && provider !== "built-in") {
          throw new Error(
            "--template selects built-in document authoring and cannot be combined with a connector --provider. Use one path.",
          );
        }
        const template =
          templateId === undefined || templateId === "default"
            ? undefined
            : (findDocumentTemplateItem(templateId) ??
              findDocumentTemplateItem(`document-template:${templateId}`));
        if (templateId !== undefined && templateId !== "default" && !template) {
          throw new Error(
            [
              `Unknown document template: ${options.template}`,
              "",
              documentChoices(),
              "",
              'Use: okou generate document --template <id-or-default> --prompt "..."',
            ].join("\n"),
          );
        }
        const dispatch = await dispatchGenerate({
          generationType: "document",
          prompt: options.prompt,
          provider,
          listChoices: async () => {
            console.log(documentChoices());
            console.log(
              '\nNext: okou generate document --prompt "<document request and output format>"',
            );
            console.log(
              "Use --template <id-or-default> to select explicitly, or --provider <connector> for connector guidance. Use --all to also discover connectors.",
            );
            if (options.all) {
              console.log("");
              await runLister("document", { all: true });
            }
          },
        });
        if (dispatch.outcome === "handled") return;

        const visibilityFlag =
          options.visibility === undefined
            ? ""
            : ` --visibility ${options.visibility}`;
        const selection = template
          ? [
              "## Built-in Template",
              ...documentTemplateInstructionLines(template),
            ]
          : templateId === "default"
            ? [
                "## Default Document Authoring",
                "- Default was explicitly selected. Author from a blank document; do not select a built-in template.",
                "- Use the platform's document authoring and QA guidance for the requested format, including the office skill when applicable.",
              ]
            : [
                "## Choose Default or a Built-in Template",
                "- Read the request and supplied materials before choosing. Match the document's purpose, required structure, audience, and visual preferences, not its name alone.",
                "- Honor an attached or explicitly named template. Otherwise choose a compatible built-in template from the catalog below, or Default when none fits. Do not force an unrelated template onto the request.",
                "- Default means authoring from a blank document using the platform's document authoring and QA guidance, including the office skill when applicable. It does not select a file format.",
                '- For a built-in template, obtain its pinned original, supporting files, and layout instructions with `okou generate document --template <id> --prompt "<same document request>"`, preserving any explicit --visibility. Follow that packet before authoring.',
                "- Make this choice yourself; do not ask the user to choose or confirm a template unless essential task information is missing.",
                "",
                documentChoices(),
              ];
        console.log(
          [
            "# Okou generate document",
            "",
            "This is an authoring instruction packet, not a completed document. Create, verify, and deliver the final document.",
            "",
            "## User Request",
            dispatch.prompt,
            "",
            "## Output Contract",
            "- Preserve the user's requested language, content, and output format. A template's source format does not override a DOCX, PDF, or other explicit delivery request.",
            "- If no format is specified, choose a suitable format for the task; do not assume HTML or Word merely because of the template's source format.",
            "- Replace sample facts with verified user information; leave missing details as placeholders rather than inventing names, terms, amounts, or metrics.",
            "",
            ...selection,
            "",
            "## Verify and Deliver",
            "- Verify the final document's content, calculations, layout, tables, and pagination in its delivery format. For a built-in template, check its previews and preserve its organization and visual design.",
            "- If an explicitly selected template cannot be read or used, report the blocker; do not silently switch to Default or claim the template was applied.",
            `- For file delivery in web chat, use \`okou web upload-file -f <file>${visibilityFlag}\`; on other integrations use their upload-file command. Files default to only-me unless the user selects another visibility.`,
            "- For hosted HTML delivery, follow the platform's preview and publishing steps and preserve the requested visibility. File-only delivery does not require HTML hosting.",
            "- Deliver one format unless the user requests multiple. State whether Default or a built-in template was used, naming the template when applicable.",
          ].join("\n"),
        );
      }),
    );
}
