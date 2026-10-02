import { randomUUID } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type {
  JsonSchemaType,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import {
  mcpGetChatThreadInputSchema,
  mcpGetChatThreadOutputSchema,
  mcpGetChatIndicatorsInputSchema,
  mcpGetChatIndicatorsOutputSchema,
  mcpListChatThreadsInputSchema,
  mcpListChatThreadsOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-threads";
import {
  mcpGetChatMessagesInputSchema,
  mcpGetChatMessagesOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-messages";
import {
  mcpSearchChatMessagesInputSchema,
  mcpSearchChatMessagesOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-search";
import {
  mcpGetChatStatusInputSchema,
  mcpGetChatStatusOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-status";
import {
  mcpListAgentsInputSchema,
  mcpListAgentsOutputSchema,
  mcpListModelsInputSchema,
  mcpListModelsOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-discovery";
import {
  mcpCreateChatThreadInputSchema,
  mcpCreateChatThreadOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-creation";
import {
  mcpUpdateChatThreadInputSchema,
  mcpUpdateChatThreadOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-thread-update";
import {
  mcpSendChatMessageInputSchema,
  mcpSendChatMessageOutputSchema,
  mcpRevokeQueuedMessageInputSchema,
  mcpRevokeQueuedMessageOutputSchema,
  mcpCancelRunInputSchema,
  mcpCancelRunOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-mutations";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mcpServerRoutes } from "../mcp-server";
import {
  resource,
  requiredScopes,
  defaultScopes,
  modernVersion,
  jsonBytes,
  measureCompactSuccess,
  rpc,
  requestBody,
  protocolHeaders,
  createMcpServerTestApi,
} from "./helpers/mcp-server";
import { createMcpServerFixtures } from "./helpers/mcp-server-fixtures";

const context = testContext();
const { client, fixture, getIndicators, waitForRejectedInput } =
  createMcpServerTestApi(context);
const { projectSearchMessages, messageFixture } =
  createMcpServerFixtures(context);

const fullCatalogToolNames = [
  "get_chat_messages",
  "search_chat_messages",
  "get_chat_status",
  "list_agents",
  "list_models",
  "get_chat_indicators",
  "list_chat_threads",
  "get_chat_thread",
  "create_chat_thread",
  "update_chat_thread",
  "send_chat_message",
  "revoke_queued_message",
  "cancel_run",
] as const;

type FullCatalogToolName = (typeof fullCatalogToolNames)[number];

const directoryFlaggedInputFields = {
  search_chat_messages: ["threadId", "agentId", "since", "before"],
  list_chat_threads: ["since", "before"],
  create_chat_thread: ["requestId", "agentId"],
  update_chat_thread: ["requestId", "threadId"],
  send_chat_message: ["threadId", "requestId"],
} as const;

type CatalogSchemaContract = {
  readonly input: StandardSchemaWithJSON;
  readonly output: StandardSchemaWithJSON;
};

type CatalogBudget = {
  readonly description: number;
  readonly inputSchema: number;
  readonly outputSchema: number;
  readonly annotations: number;
  readonly total: number;
};

function standardSchema(schema: z.ZodType): StandardSchemaWithJSON {
  return schema as unknown as StandardSchemaWithJSON;
}

const catalogContracts = {
  get_chat_messages: {
    input: standardSchema(mcpGetChatMessagesInputSchema),
    output: standardSchema(mcpGetChatMessagesOutputSchema),
  },
  search_chat_messages: {
    input: standardSchema(mcpSearchChatMessagesInputSchema),
    output: standardSchema(mcpSearchChatMessagesOutputSchema),
  },
  get_chat_status: {
    input: standardSchema(mcpGetChatStatusInputSchema),
    output: standardSchema(mcpGetChatStatusOutputSchema),
  },
  list_agents: {
    input: standardSchema(mcpListAgentsInputSchema),
    output: standardSchema(mcpListAgentsOutputSchema),
  },
  list_models: {
    input: standardSchema(mcpListModelsInputSchema),
    output: standardSchema(mcpListModelsOutputSchema),
  },
  get_chat_indicators: {
    input: standardSchema(mcpGetChatIndicatorsInputSchema),
    output: standardSchema(mcpGetChatIndicatorsOutputSchema),
  },
  list_chat_threads: {
    input: standardSchema(mcpListChatThreadsInputSchema),
    output: standardSchema(mcpListChatThreadsOutputSchema),
  },
  get_chat_thread: {
    input: standardSchema(mcpGetChatThreadInputSchema),
    output: standardSchema(mcpGetChatThreadOutputSchema),
  },
  create_chat_thread: {
    input: standardSchema(mcpCreateChatThreadInputSchema),
    output: standardSchema(mcpCreateChatThreadOutputSchema),
  },
  update_chat_thread: {
    input: standardSchema(mcpUpdateChatThreadInputSchema),
    output: standardSchema(mcpUpdateChatThreadOutputSchema),
  },
  send_chat_message: {
    input: standardSchema(mcpSendChatMessageInputSchema),
    output: standardSchema(mcpSendChatMessageOutputSchema),
  },
  revoke_queued_message: {
    input: standardSchema(mcpRevokeQueuedMessageInputSchema),
    output: standardSchema(mcpRevokeQueuedMessageOutputSchema),
  },
  cancel_run: {
    input: standardSchema(mcpCancelRunInputSchema),
    output: standardSchema(mcpCancelRunOutputSchema),
  },
} satisfies Record<FullCatalogToolName, CatalogSchemaContract>;

const fullCatalogBudgets = {
  get_chat_messages: {
    description: 517,
    inputSchema: 749,
    outputSchema: 2153,
    annotations: 118,
    total: 3626,
  },
  search_chat_messages: {
    description: 627,
    inputSchema: 1543,
    outputSchema: 2142,
    annotations: 120,
    total: 4524,
  },
  get_chat_status: {
    description: 1057,
    inputSchema: 1173,
    outputSchema: 6251,
    annotations: 115,
    total: 8683,
  },
  list_agents: {
    description: 321,
    inputSchema: 241,
    outputSchema: 832,
    annotations: 111,
    total: 1588,
  },
  list_models: {
    description: 368,
    inputSchema: 119,
    outputSchema: 1026,
    annotations: 111,
    total: 1707,
  },
  get_chat_indicators: {
    description: 200,
    inputSchema: 130,
    outputSchema: 1500,
    annotations: 125,
    total: 2050,
  },
  list_chat_threads: {
    description: 524,
    inputSchema: 1343,
    outputSchema: 2908,
    annotations: 117,
    total: 4981,
  },
  get_chat_thread: {
    description: 421,
    inputSchema: 366,
    outputSchema: 2814,
    annotations: 115,
    total: 3803,
  },
  create_chat_thread: {
    description: 701,
    inputSchema: 797,
    outputSchema: 5195,
    annotations: 119,
    total: 6902,
  },
  update_chat_thread: {
    description: 563,
    inputSchema: 871,
    outputSchema: 2371,
    annotations: 120,
    total: 4015,
  },
  send_chat_message: {
    description: 578,
    inputSchema: 669,
    outputSchema: 2843,
    annotations: 118,
    total: 4297,
  },
  revoke_queued_message: {
    description: 293,
    inputSchema: 779,
    outputSchema: 1215,
    annotations: 121,
    total: 2501,
  },
  cancel_run: {
    description: 274,
    inputSchema: 360,
    outputSchema: 473,
    annotations: 109,
    total: 1298,
  },
} satisfies Record<FullCatalogToolName, CatalogBudget>;

const representativeSchemaValues: readonly unknown[] = [
  null,
  [],
  {},
  { unexpected: true },
  { limit: 1 },
  { threadId: "00000000-0000-4000-8000-000000000000" },
  { query: "chat" },
  { runId: "00000000-0000-4000-8000-000000000000" },
  {
    inputRef: {
      threadId: "00000000-0000-4000-8000-000000000000",
      eventId: "00000000-0000-4000-8000-000000000001",
      seqId: 1,
    },
  },
  {
    threadId: "00000000-0000-4000-8000-000000000000",
    text: "Continue",
    requestId: "00000000-0000-4000-8000-000000000000",
  },
  { agents: [], nextCursor: null },
  {
    models: [],
    defaultModel: { model: null, source: null },
    admission: "checked_on_send",
  },
  { threads: [], nextCursor: null },
  { agents: {}, threads: {}, unreadAt: {} },
  { messages: [], olderCursor: null, newerCursor: null },
  { matches: [], nextCursor: null, scanLimited: false },
  {
    inputRef: {
      threadId: "00000000-0000-4000-8000-000000000000",
      eventId: "00000000-0000-4000-8000-000000000001",
      seqId: 1,
    },
    outcome: "not_revocable",
    runId: null,
    reason: "not_queued",
  },
  {
    runId: "00000000-0000-4000-8000-000000000000",
    status: "cancelled",
    alreadyCancelled: false,
  },
];

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProvablyObjectShapedRoot(schema: Record<string, unknown>): boolean {
  if (
    "properties" in schema ||
    "patternProperties" in schema ||
    "additionalProperties" in schema ||
    "required" in schema
  ) {
    return true;
  }
  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    const members = schema[keyword];
    if (
      Array.isArray(members) &&
      members.length > 0 &&
      members.every((member) => {
        return (
          isJsonObject(member) &&
          (member.type === "object" || isProvablyObjectShapedRoot(member))
        );
      })
    ) {
      return true;
    }
  }
  return false;
}

function canonicalJsonSchema(
  schema: StandardSchemaWithJSON,
  io: "input" | "output",
): Record<string, unknown> {
  const converted = schema["~standard"].jsonSchema[io]({
    target: "draft-2020-12",
  });
  if (io === "input") {
    if (converted.type !== undefined && converted.type !== "object") {
      throw new Error("MCP input schema root must be an object");
    }
    return { type: "object", ...converted };
  }
  return converted.type === undefined && isProvablyObjectShapedRoot(converted)
    ? { type: "object", ...converted }
    : converted;
}

function jsonPointerValue(root: unknown, reference: string): unknown {
  if (!reference.startsWith("#/")) {
    throw new Error(`Expected a local JSON Pointer, received ${reference}`);
  }
  let value = root;
  for (const encodedSegment of reference.slice(2).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(value)) {
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) {
        throw new Error(`Unresolved JSON Pointer ${reference}`);
      }
      value = value.at(index);
      continue;
    }
    if (!isJsonObject(value)) {
      throw new Error(`Unresolved JSON Pointer ${reference}`);
    }
    const entry = Object.entries(value).find(([key]) => {
      return key === segment;
    });
    if (!entry) {
      throw new Error(`Unresolved JSON Pointer ${reference}`);
    }
    value = entry[1];
  }
  return value;
}

function resolveLocalJsonSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  function resolve(
    value: unknown,
    activeReferences: ReadonlySet<string>,
  ): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => {
        return resolve(item, activeReferences);
      });
    }
    if (!isJsonObject(value)) {
      return value;
    }
    if (typeof value.$ref === "string") {
      if (
        Object.keys(value).some((key) => {
          return key !== "$ref";
        })
      ) {
        throw new Error(`Unsupported sibling next to $ref ${value.$ref}`);
      }
      if (activeReferences.has(value.$ref)) {
        throw new Error(`Cyclic local JSON Pointer ${value.$ref}`);
      }
      return resolve(
        jsonPointerValue(schema, value.$ref),
        new Set(activeReferences).add(value.$ref),
      );
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => {
          return key !== "$defs";
        })
        .map(([key, child]) => {
          return [key, resolve(child, activeReferences)];
        }),
    );
  }

  const resolved = resolve(schema, new Set());
  if (!isJsonObject(resolved)) {
    throw new Error("Resolved JSON Schema root must be an object");
  }
  return resolved;
}

function measureCatalogTool(tool: {
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly annotations: Record<string, unknown>;
}): CatalogBudget {
  return {
    description: jsonBytes(tool.description),
    inputSchema: jsonBytes(tool.inputSchema),
    outputSchema: jsonBytes(tool.outputSchema),
    annotations: jsonBytes(tool.annotations),
    total: jsonBytes(tool),
  };
}

function expectDirectoryFlaggedInputFields(tool: {
  readonly name: string;
  readonly inputSchema: Record<string, unknown>;
}): void {
  const fields =
    directoryFlaggedInputFields[
      tool.name as keyof typeof directoryFlaggedInputFields
    ];
  if (!fields) {
    return;
  }
  const properties = tool.inputSchema.properties;
  if (!isJsonObject(properties)) {
    throw new Error(`${tool.name} must advertise input properties`);
  }
  for (const field of fields) {
    expect(properties[field]).toMatchObject({ type: "string" });
    if (field.endsWith("Id")) {
      expect(properties[field]).toMatchObject({ format: "uuid" });
    } else {
      expect(properties[field]).toHaveProperty("allOf");
    }
  }
}

function catalogArrayOverhead(toolCount: number): number {
  return toolCount === 0 ? 2 : toolCount + 1;
}

describe("MCP schema interoperability", () => {
  it("compiles exact-input and latest-thread status with the SDK AJV validator", () => {
    const validate = new AjvJsonSchemaValidator().getValidator(
      z.toJSONSchema(mcpGetChatStatusInputSchema) as JsonSchemaType,
    );
    const threadId = randomUUID();

    expect(
      validate({
        inputRef: { threadId, eventId: randomUUID(), seqId: 1 },
        waitMs: 1000,
      }),
    ).toMatchObject({ valid: true });
    expect(validate({ threadId })).toMatchObject({ valid: true });
  });
});

describe("external MCP entry", () => {
  it.each([
    { modern: true, scopes: requiredScopes },
    { modern: false, scopes: requiredScopes },
    { modern: true, scopes: defaultScopes },
  ])(
    "discovers and calls chat discovery with modern=$modern and scopes=$scopes",
    async ({ modern, scopes }) => {
      const auth = await fixture();
      const token = auth.token({ scope: scopes });
      if (!modern) {
        const initialized = await accept(
          client().request({
            extraHeaders: protocolHeaders(token, "initialize", false),
            body: {
              jsonrpc: "2.0",
              id: 0,
              method: "initialize",
              params: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                clientInfo: { name: "okou-test", version: "1" },
              },
            },
          }),
          [200],
        );
        expect(rpc(initialized.body)).toMatchObject({
          result: { protocolVersion: "2025-11-25" },
        });
      }
      const listed = await accept(
        client().request({
          extraHeaders: protocolHeaders(token, "tools/list", modern),
          body: requestBody("tools/list", modern),
        }),
        [200],
      );
      const listedPayload = rpc(listed.body);
      const listedTools = z
        .object({
          result: z.object({
            tools: z.array(
              z.looseObject({
                name: z.string(),
                description: z.string(),
                inputSchema: z.record(z.string(), z.unknown()),
                outputSchema: z.record(z.string(), z.unknown()),
                annotations: z.record(z.string(), z.unknown()),
              }),
            ),
          }),
        })
        .parse(listedPayload).result.tools;
      expect(listedPayload).toMatchObject({
        result: {
          tools: [
            { name: "get_chat_messages", annotations: { readOnlyHint: true } },
            {
              name: "search_chat_messages",
              annotations: { readOnlyHint: true },
            },
            { name: "get_chat_status", annotations: { readOnlyHint: true } },
            {
              name: "list_agents",
              inputSchema: {
                type: "object",
                properties: { limit: { maximum: 50 } },
              },
              annotations: { readOnlyHint: true },
            },
            { name: "list_models", annotations: { readOnlyHint: true } },
            {
              name: "get_chat_indicators",
              annotations: { readOnlyHint: true },
            },
            {
              name: "list_chat_threads",
              inputSchema: {
                properties: {
                  title: {
                    minLength: 1,
                    maxLength: 200,
                    pattern: "\\S",
                  },
                },
              },
              annotations: { readOnlyHint: true },
            },
            { name: "get_chat_thread", annotations: { readOnlyHint: true } },
            ...(scopes === defaultScopes
              ? [
                  {
                    name: "create_chat_thread",
                    description: expect.stringContaining(
                      "omitted model stores the member preference or system default at creation",
                    ),
                    inputSchema: {
                      properties: {
                        title: { pattern: "\\S" },
                        model: {
                          minLength: 1,
                          maxLength: 255,
                          pattern: "\\S",
                        },
                        message: {
                          maxLength: 32_000,
                          pattern: "\\S",
                        },
                      },
                    },
                    annotations: {
                      readOnlyHint: false,
                      idempotentHint: false,
                      openWorldHint: true,
                    },
                  },
                  {
                    name: "update_chat_thread",
                    description: expect.stringContaining(
                      "model:null clears the pin; future inputs capture the system default at enqueue without changing the pin",
                    ),
                    inputSchema: {
                      properties: {
                        patch: {
                          minProperties: 1,
                          properties: {
                            title: { pattern: "\\S" },
                            model: {
                              anyOf: [
                                {
                                  minLength: 1,
                                  maxLength: 255,
                                  pattern: "\\S",
                                },
                                { type: "null" },
                              ],
                            },
                          },
                        },
                      },
                    },
                    annotations: { readOnlyHint: false, idempotentHint: false },
                  },
                  {
                    name: "send_chat_message",
                    inputSchema: {
                      properties: {
                        text: { maxLength: 32_000, pattern: "\\S" },
                      },
                    },
                    annotations: { readOnlyHint: false, idempotentHint: false },
                  },
                  {
                    name: "revoke_queued_message",
                    annotations: {
                      readOnlyHint: false,
                      destructiveHint: true,
                      idempotentHint: true,
                    },
                  },
                  {
                    name: "cancel_run",
                    annotations: {
                      readOnlyHint: false,
                      destructiveHint: true,
                      idempotentHint: true,
                    },
                  },
                ]
              : []),
          ],
        },
      });
      const schemaValidator = new AjvJsonSchemaValidator();
      for (const tool of listedTools) {
        expect(() => {
          schemaValidator.getValidator(tool.inputSchema as JsonSchemaType);
          schemaValidator.getValidator(tool.outputSchema as JsonSchemaType);
        }).not.toThrow();
      }
      if (scopes === defaultScopes) {
        const listedNames = listedTools.map((tool) => {
          return tool.name;
        });
        expect(listedNames).toStrictEqual(fullCatalogToolNames);
        expect(Object.keys(catalogContracts)).toStrictEqual(
          fullCatalogToolNames,
        );
        expect(Object.keys(fullCatalogBudgets)).toStrictEqual(
          fullCatalogToolNames,
        );

        for (const tool of listedTools) {
          if (!(tool.name in fullCatalogBudgets)) {
            throw new Error(`Missing catalog budget for ${tool.name}`);
          }
          const toolName = tool.name as FullCatalogToolName;
          const title = z.string().min(2).parse(tool.annotations.title);
          expect(title).toMatch(/^[A-Z][A-Za-z ]+$/u);
          expectDirectoryFlaggedInputFields(tool);
          const measured = measureCatalogTool(tool);
          const budget = fullCatalogBudgets[toolName];
          for (const component of [
            "description",
            "inputSchema",
            "outputSchema",
            "annotations",
            "total",
          ] as const) {
            expect(
              measured[component],
              `${toolName}.${component} exceeds its reviewed budget`,
            ).toBeLessThanOrEqual(budget[component]);
          }

          const contract = catalogContracts[toolName];
          for (const [schemaName, advertised, canonical] of [
            [
              "inputSchema",
              tool.inputSchema,
              canonicalJsonSchema(contract.input, "input"),
            ],
            [
              "outputSchema",
              tool.outputSchema,
              canonicalJsonSchema(contract.output, "output"),
            ],
          ] as const) {
            expect(
              advertised,
              `${toolName}.${schemaName} must inline the canonical contract`,
            ).toStrictEqual(resolveLocalJsonSchema(canonical));
            expect(JSON.stringify(advertised)).not.toMatch(/"\$(?:ref|defs)"/u);
            const advertisedValidator = schemaValidator.getValidator(
              advertised as JsonSchemaType,
            );
            const canonicalValidator = schemaValidator.getValidator(
              canonical as JsonSchemaType,
            );
            for (const value of representativeSchemaValues) {
              expect(
                advertisedValidator(value).valid,
                `${toolName}.${schemaName} must validate representative values equivalently`,
              ).toBe(canonicalValidator(value).valid);
            }
          }
        }
        const catalogBudget =
          catalogArrayOverhead(listedTools.length) +
          listedTools.reduce((total, tool) => {
            return (
              total + fullCatalogBudgets[tool.name as FullCatalogToolName].total
            );
          }, 0);
        expect(jsonBytes(listedTools)).toBeLessThanOrEqual(catalogBudget);
        const safetyTerms = {
          get_chat_messages: [
            /nextContentCursor/iu,
            /UTF-16/iu,
            /does not mark read/iu,
            /8 MiB/iu,
          ],
          search_chat_messages: [
            /scanLimited/iu,
            /do not prove absence/iu,
            /does not mark read/iu,
            /32 MiB/iu,
          ],
          get_chat_status: [
            /waitMs/iu,
            /current state, not a run outcome/iu,
            /messagePage/iu,
            /Disconnect cancels only the waiter/iu,
            /retryAfterMs/iu,
            /ready means current materialized output/iu,
            /neither marks read nor changes or cancels/iu,
          ],
          list_agents: [/24 hours/iu, /visibility/iu],
          list_models: [/admission/iu, /does not repair/iu, /model settings/iu],
          get_chat_indicators: [/does not mark read/iu, /not run completion/iu],
          list_chat_threads: [/does not mark read/iu, /get_chat_indicators/iu],
          get_chat_thread: [
            /neither reads messages nor marks read/iu,
            /not prove/iu,
          ],
          create_chat_thread: [
            /24 hours/iu,
            /retryUntil/u,
            /not generally idempotent/iu,
            /inspect/iu,
            /admission/iu,
          ],
          update_chat_thread: [
            /24 hours/iu,
            /retryUntil/u,
            /not generally idempotent/iu,
            /inspect/iu,
            /active run/iu,
          ],
          send_chat_message: [
            /24 hours/iu,
            /retryUntil/u,
            /not generally idempotent/iu,
            /inspect/iu,
            /not proof/iu,
            /get_chat_status/iu,
          ],
          revoke_queued_message: [/never cancels a run/iu, /not_revocable/iu],
          cancel_run: [/neither revokes/iu, /prior effects/iu],
        } as const;
        expect(Object.keys(safetyTerms)).toStrictEqual(fullCatalogToolNames);
        for (const tool of listedTools) {
          const terms = safetyTerms[tool.name as keyof typeof safetyTerms];
          expect(terms, `Unexpected tool ${tool.name}`).toBeDefined();
          for (const term of terms ?? []) {
            expect(tool.description).toMatch(term);
          }
        }
      }
      const result = await accept(
        client().request({
          extraHeaders: protocolHeaders(token, "tools/call", modern),
          body: requestBody("tools/call", modern, {
            name: "list_chat_threads",
            arguments: {},
          }),
        }),
        [200],
      );
      expect(rpc(result.body)).toMatchObject({
        result: {
          structuredContent: {
            threads: [],
            nextCursor: null,
          },
          content: [{ type: "text" }],
        },
      });
      const indicators = await getIndicators(token);
      expect(indicators).toStrictEqual({
        agents: {},
        threads: {},
        unreadAt: {},
      });
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect(result.headers.get("content-type")).toContain(
        modern ? "application/json" : "text/event-stream",
      );
      if (!modern) {
        expect(typeof result.body).toBe("string");
      }
    },
  );

  it.each([true, false])(
    "works with the generic MCP SDK client with modern=%s",
    async (modern) => {
      const f = await messageFixture();
      const auth = f.auth;
      const app = createAppWithRoutes({
        routes: mcpServerRoutes,
        signal: context.signal,
      });
      const transport = new StreamableHTTPClientTransport(new URL(resource), {
        authProvider: {
          token: () => {
            return Promise.resolve(auth.token({ scope: defaultScopes }));
          },
        },
        fetch: async (input, init) => {
          return await app.request(new Request(input, init));
        },
      });
      const sdk = new Client(
        { name: "okou-interoperability-test", version: "1" },
        {
          versionNegotiation: {
            mode: modern ? { pin: modernVersion } : "legacy",
          },
        },
      );
      onTestFinished(() => {
        return sdk.close();
      });
      await sdk.connect(transport);
      expect(sdk.getDiscoverResult() !== undefined).toBe(modern);
      const tools = await sdk.listTools();
      expect(
        tools.tools.map((tool) => {
          return tool.name;
        }),
      ).toStrictEqual(fullCatalogToolNames);
      const advertisedOutputValidators = new Map(
        tools.tools.map((tool) => {
          const validator = new AjvJsonSchemaValidator().getValidator(
            tool.outputSchema as JsonSchemaType,
          );
          return [tool.name, validator] as const;
        }),
      );
      const canonicalOutputValidators = new Map(
        fullCatalogToolNames.map((toolName) => {
          const validator = new AjvJsonSchemaValidator().getValidator(
            canonicalJsonSchema(
              catalogContracts[toolName].output,
              "output",
            ) as JsonSchemaType,
          );
          return [toolName, validator] as const;
        }),
      );
      const result = await sdk.callTool({
        name: "list_chat_threads",
        arguments: {},
      });
      expect(result).toMatchObject({
        structuredContent: { threads: [], nextCursor: null },
      });
      const indicatorResult = await sdk.callTool({
        name: "get_chat_indicators",
        arguments: {},
      });
      expect(indicatorResult.isError).not.toBeTruthy();
      expect(
        mcpGetChatIndicatorsOutputSchema.parse(
          indicatorResult.structuredContent,
        ),
      ).toStrictEqual({ agents: {}, threads: {}, unreadAt: {} });
      const sent = await f.send("sdksearchneedle context handoff");
      for (let index = 1; index < 5; index++) {
        await f.send(`sdksearchneedle context handoff ${index}`, sent.threadId);
      }
      await projectSearchMessages([sent.threadId]);
      const searched = await sdk.callTool({
        name: "search_chat_messages",
        arguments: { query: "sdksearchneedle" },
      });
      expect(searched.isError).not.toBeTruthy();
      const match = mcpSearchChatMessagesOutputSchema.parse(
        searched.structuredContent,
      ).matches[0];
      if (!match) {
        throw new Error(
          "Expected the generic SDK search to return a real reference",
        );
      }
      const around = await sdk.callTool({
        name: "get_chat_messages",
        arguments: {
          threadId: match.ref.threadId,
          around: { eventId: match.ref.eventId, seqId: match.ref.seqId },
          limit: 1,
        },
      });
      expect(around).toMatchObject({
        structuredContent: {
          messages: [
            {
              ref: match.ref,
              text: expect.stringContaining("sdksearchneedle"),
            },
          ],
        },
      });
      const requestId = randomUUID();
      const submitted = await sdk.callTool({
        name: "send_chat_message",
        arguments: {
          threadId: sent.threadId,
          text: "Submitted by a generic MCP client",
          requestId,
        },
      });
      expect(submitted.isError).not.toBeTruthy();
      const receipt = mcpSendChatMessageOutputSchema.parse(
        submitted.structuredContent,
      );
      expect(receipt).toMatchObject({
        inputRef: { threadId: sent.threadId, eventId: requestId },
        replayed: false,
        runId: null,
      });
      // The send only enqueues; the background pick rejects the input.
      await waitForRejectedInput(
        auth.token({ scope: defaultScopes }),
        receipt.inputRef,
      );
      const status = await sdk.callTool({
        name: "get_chat_status",
        arguments: receipt.nextAction.arguments,
      });
      expect(status).toMatchObject({
        structuredContent: {
          threadId: sent.threadId,
          lifecycle: {
            phase: "settled",
            outcome: "rejected",
            output: "none",
          },
          messages: null,
          retryAfterMs: null,
        },
      });
      const representativeResults = [
        ["list_chat_threads", result],
        ["search_chat_messages", searched],
        ["get_chat_messages", around],
        ["send_chat_message", submitted],
        ["get_chat_status", status],
      ] as const;
      const measurements = representativeResults.map(
        ([toolName, toolResult]) => {
          const validateOutput = advertisedOutputValidators.get(toolName);
          if (!validateOutput) {
            throw new Error(`Missing output validator for ${toolName}`);
          }
          const validateCanonicalOutput =
            canonicalOutputValidators.get(toolName);
          if (!validateCanonicalOutput) {
            throw new Error(
              `Missing canonical output validator for ${toolName}`,
            );
          }
          const advertisedValidation = validateOutput(
            toolResult.structuredContent,
          );
          const canonicalValidation = validateCanonicalOutput(
            toolResult.structuredContent,
          );
          expect(advertisedValidation).toMatchObject({ valid: true });
          expect(canonicalValidation).toMatchObject({ valid: true });
          expect(advertisedValidation.valid).toBe(canonicalValidation.valid);
          return measureCompactSuccess(toolResult);
        },
      );
      const baselineBytes = measurements.reduce((total, measurement) => {
        return total + measurement.baselineBytes;
      }, 0);
      const compactBytes = measurements.reduce((total, measurement) => {
        return total + measurement.compactBytes;
      }, 0);
      expect(compactBytes).toBeLessThanOrEqual(Math.floor(baselineBytes * 0.6));
      const missing = await sdk.callTool({
        name: "get_chat_thread",
        arguments: { threadId: randomUUID() },
      });
      expect(missing.isError).toBeTruthy();
    },
  );
});
