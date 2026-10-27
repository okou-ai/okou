import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Command } from "commander";
import { string, uuid } from "zod";
import {
  suggestionCreateSchema,
  suggestionUpdateSchema,
  type Suggestion,
} from "@okouai/api-contracts/contracts/suggestions";
import {
  createSuggestion,
  updateSuggestion,
  deleteSuggestion,
  listSuggestions,
} from "../../lib/api/domains/suggestions";
import { ApiRequestError } from "../../lib/api/core/client-factory";
import { withErrorHandler } from "../../lib/command/with-error-handler";

async function readInput(path: string): Promise<unknown> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 65536)
    throw new Error(
      "Suggestion input must be a JSON file of at most 65536 bytes.",
    );
  return JSON.parse(await readFile(path, "utf8"));
}
function printSuggestion(item: Suggestion, json?: boolean) {
  console.log(
    json
      ? JSON.stringify(item)
      : `${item.id}  priority=${item.priority}  ${item.title}\nEdit: okou suggestion update ${item.id} --file suggestion.json`,
  );
}
function jsonError(
  error: unknown,
  options: { readonly json?: boolean },
): boolean {
  if (!options.json) return false;
  console.error(
    JSON.stringify({
      error: {
        code: error instanceof ApiRequestError ? error.code : "INVALID_INPUT",
        message:
          error instanceof Error ? error.message : "Suggestion command failed",
      },
    }),
  );
  return true;
}
interface CreateOptions {
  readonly file?: string;
  readonly text?: string;
  readonly background?: string;
  readonly id?: string;
  readonly title?: string;
  readonly rationale?: string;
  readonly threadId?: string;
  readonly priority?: string;
  readonly json?: boolean;
}
function textDraft(text: string) {
  return {
    draftUserMessage: {
      version: 1 as const,
      parts: [{ type: "text" as const, text }],
    },
    draftAttachments: null,
  };
}
export function createSuggestionCommand() {
  const suggestionCommand = new Command("suggestion").description(
    "Manage your next-step suggestions from Okou",
  );
  suggestionCommand
    .command("identity")
    .description(
      "Derive a stable UUID for one source object/event and next action",
    )
    .requiredOption(
      "--key <key>",
      "Stable provider, object/event identity and specific action; exclude run IDs and dates",
    )
    .option("--json", "Output JSON")
    .action(
      withErrorHandler(
        async (options: { readonly key: string; readonly json?: boolean }) => {
          const key = string().trim().min(1).max(2048).parse(options.key);
          // UUID v5 with a fixed Okou suggestion namespace; this never publishes an item.
          const bytes = createHash("sha1")
            .update(Buffer.from("a91f53c81e9d54d6a3f99cda27e35e48", "hex"))
            .update(key)
            .digest()
            .subarray(0, 16);
          bytes[6] = (bytes.readUInt8(6) & 0x0f) | 0x50;
          bytes[8] = (bytes.readUInt8(8) & 0x3f) | 0x80;
          const hex = bytes.toString("hex");
          const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
          console.log(options.json ? JSON.stringify({ id }) : id);
        },
        jsonError,
      ),
    );
  suggestionCommand
    .command("list")
    .description(
      "Read active suggestions and recent consumed/removed identities",
    )
    .option("--json", "Output JSON")
    .action(
      withErrorHandler(async (options: { readonly json?: boolean }) => {
        const data = await listSuggestions();
        if (options.json) console.log(JSON.stringify(data));
        else if (data.suggestions.length === 0)
          console.log(
            "No active suggestions. Create one with: okou suggestion create --file suggestion.json",
          );
        else
          for (const item of data.suggestions)
            console.log(`${item.id}  priority=${item.priority}  ${item.title}`);
      }, jsonError),
    );
  suggestionCommand
    .command("create")
    .description(
      "Publish a suggestion; reuse its UUID and exact file when retrying",
    )
    .option(
      "--file <path>",
      "JSON containing id, title, rationale, priority, action options and a complete neutral customOption draft",
    )
    .option("--text <text>", "Text converted to the normal composer document")
    .option(
      "--background <text>",
      "Complete neutral background for custom follow-up; required with --text",
    )
    .option(
      "--id <uuid>",
      "Stable creation identity for text input and retries",
    )
    .option("--title <title>", "Action title for text input")
    .option("--rationale <text>", "Why this action is useful")
    .option(
      "--thread-id <uuid>",
      "Existing conversation; omitted means a new Okou conversation",
    )
    .option("--priority <integer>", "Larger values appear first")
    .option("--json", "Output JSON")
    .action(
      withErrorHandler(async (options: CreateOptions) => {
        if (
          options.file &&
          [
            options.text,
            options.background,
            options.id,
            options.title,
            options.rationale,
            options.threadId,
            options.priority,
          ].some((value) => {
            return value !== undefined;
          })
        )
          throw new Error("Use --file or text input fields, not both.");
        if (!options.file && options.text === undefined)
          throw new Error(
            "Provide --file suggestion.json or --text with --id, --title and --background.",
          );
        if (!options.file && !options.background?.trim())
          throw new Error(
            "Provide --background with the complete neutral context, or use --file suggestion.json.",
          );
        const body = suggestionCreateSchema.parse(
          options.file
            ? await readInput(options.file)
            : {
                id: options.id,
                title: options.title,
                rationale: options.rationale ?? "",
                priority: Number(options.priority ?? "0"),
                customOption: {
                  id: "custom",
                  threadId: null,
                  draft: {
                    draftUserMessage: {
                      version: 1,
                      parts: [
                        {
                          type: "feedback",
                          quote: options.background,
                          note: [],
                        },
                      ],
                    },
                    draftAttachments: null,
                  },
                },
                options: [
                  {
                    id: "default",
                    label: options.title,
                    description: options.rationale ?? "",
                    threadId: options.threadId ?? null,
                    draft: textDraft(options.text ?? ""),
                  },
                ],
              },
        );
        printSuggestion(await createSuggestion(body), options.json);
      }, jsonError),
    );
  suggestionCommand
    .command("update")
    .description("Update an active suggestion's content or priority")
    .argument("<id>", "Suggestion UUID")
    .option("--file <path>", "JSON containing the fields to update")
    .option("--priority <integer>", "Change this suggestion's priority")
    .option("--json", "Output JSON")
    .action(
      withErrorHandler(
        async (
          id: string,
          options: {
            readonly file?: string;
            readonly priority?: string;
            readonly json?: boolean;
          },
        ) => {
          if (options.file && options.priority !== undefined)
            throw new Error("Use --file or field options, not both.");
          const body = suggestionUpdateSchema.parse(
            options.file
              ? await readInput(options.file)
              : options.priority !== undefined
                ? { priority: Number(options.priority) }
                : {},
          );
          printSuggestion(
            await updateSuggestion(uuid().parse(id), body),
            options.json,
          );
        },
        (error, _id, options) => {
          return jsonError(error, options);
        },
      ),
    );
  suggestionCommand
    .command("delete")
    .description("Withdraw an active suggestion")
    .argument("<id>", "Suggestion UUID")
    .option("--json", "Output JSON")
    .action(
      withErrorHandler(
        async (id: string, options: { readonly json?: boolean }) => {
          await deleteSuggestion(uuid().parse(id));
          console.log(
            options.json
              ? JSON.stringify({ id, removed: true })
              : `Suggestion withdrawn. Inspect the pool: okou suggestion list --json`,
          );
        },
        (error, _id, options) => {
          return jsonError(error, options);
        },
      ),
    );
  return suggestionCommand;
}
export const suggestionCommand = createSuggestionCommand();
