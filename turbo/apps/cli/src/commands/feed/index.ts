import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Command } from "commander";
import { object, string, uuid } from "zod";
import {
  feedItemTypeSchema,
  suggestionCreateSchema,
  suggestionUpdateSchema,
  type Suggestion,
} from "@okouai/api-contracts/contracts/feed";
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
      : `${item.id}  priority=${item.priority}  ${item.content.title}\nEdit: okou feed update ${item.id} --file suggestion.json`,
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
  readonly type?: string;
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
export function createFeedCommand() {
  const feedCommand = new Command("feed").description(
    "Manage typed feed items from Okou",
  );
  feedCommand
    .command("identity")
    .requiredOption("--type <type>", "Feed item type (suggestion)")
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
        async (options: {
          readonly key: string;
          readonly type: string;
          readonly json?: boolean;
        }) => {
          feedItemTypeSchema.parse(options.type);
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
  feedCommand
    .command("list")
    .option("--type <type>", "Filter by feed item type (suggestion)")
    .description(
      "Read active suggestions and recent consumed/removed identities",
    )
    .option(
      "--all",
      "Read a page of all active cards, including those beyond the homepage limit",
    )
    .option("--after <uuid>", "Continue an --all page from nextAfter")
    .option("--json", "Output JSON")
    .action(
      withErrorHandler(
        async (options: {
          readonly json?: boolean;
          readonly all?: boolean;
          readonly type?: string;
          readonly after?: string;
        }) => {
          if (options.after && !options.all)
            throw new Error("Use --after with --all.");
          const data = await listSuggestions({
            ...options,
            type:
              options.type === undefined
                ? undefined
                : feedItemTypeSchema.parse(options.type),
          });
          if (options.json) console.log(JSON.stringify(data));
          else if (data.items.length === 0)
            console.log(
              "No active suggestions. Create one with: okou feed create --file suggestion.json",
            );
          else
            for (const item of data.items)
              console.log(
                `${item.id}  priority=${item.priority}  ${item.content.title}`,
              );
          if (!options.json && "nextAfter" in data && data.nextAfter) {
            console.log(
              `Continue with: okou feed list --all --after ${data.nextAfter} --json`,
            );
          }
        },
        jsonError,
      ),
    );
  feedCommand
    .command("create")
    .option(
      "--type <type>",
      "Feed item type; required here or in the input file",
    )
    .description(
      "Publish a suggestion; reuse its UUID and exact file when retrying",
    )
    .option(
      "--file <path>",
      "JSON containing id, type, priority and nested suggestion content (title, rationale, options and customOption)",
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
        const input = options.file
          ? object({ type: feedItemTypeSchema.optional() })
              .passthrough()
              .parse(await readInput(options.file))
          : {
              id: options.id,
              priority: Number(options.priority ?? "0"),
              content: {
                title: options.title,
                rationale: options.rationale ?? "",
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
            };
        const fileType = "type" in input ? input.type : undefined;
        if (
          options.type !== undefined &&
          fileType !== undefined &&
          options.type !== fileType
        ) {
          throw new Error("The --type value must match the input file type.");
        }
        const body = suggestionCreateSchema.parse({
          ...input,
          type: feedItemTypeSchema.parse(options.type ?? fileType),
        });
        printSuggestion(await createSuggestion(body), options.json);
      }, jsonError),
    );
  feedCommand
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
  feedCommand
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
              : `Suggestion withdrawn. Inspect the pool: okou feed list --json`,
          );
        },
        (error, _id, options) => {
          return jsonError(error, options);
        },
      ),
    );
  return feedCommand;
}
export const feedCommand = createFeedCommand();
