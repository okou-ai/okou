import { createHash, randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { pushSubscriptionsContract } from "@okouai/api-contracts/contracts/push-subscriptions";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import { z } from "zod";

import { mockOptionalEnv } from "../../../../lib/env";
import { nowDate } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { modelPoliciesRoutes } from "../../model-policies";
import { pushSubscriptionsRoutes } from "../../push-subscriptions";
import { sessionHistoryBlobBodyForKey } from "./api-bdd-session-history";
import type { ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";
import { installArtifactReferenceStorage } from "./artifact-reference-storage";
import { openRouterModelContractError } from "./openrouter-model-contract";
import type { AgentEvent } from "../../../../lib/event-consumer/verify";

const CHAT_CALLBACK_URL = "http://localhost:3000/api/internal/callbacks/chat";
const OPENROUTER_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";

type OrgModelPolicies = z.infer<
  (typeof modelPoliciesMainContract.update)["body"]
>["policies"];

const openRouterCompletionBodySchema = z.object({
  model: z.string(),
  max_tokens: z.number().optional(),
  reasoning: z.object({ effort: z.string() }).optional(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

type OpenRouterCompletionBody = z.infer<typeof openRouterCompletionBodySchema>;

/**
 * A completion the upstream cut short. Whether the partial text survives is a
 * per-caller decision: prose summaries keep it, while immutably persisted
 * titles and JSON output reject it. Tests use this to prove both halves.
 */
interface TruncatedOpenRouterCompletion {
  readonly content: string;
  readonly finishReason: "length";
}

type OpenRouterCompletionResult =
  | string
  | TruncatedOpenRouterCompletion
  | Response;

interface StoredS3Object {
  readonly bucket: string;
  readonly body?: Uint8Array;
  readonly contentType?: string;
  readonly key: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly size: number;
}

interface CapturedS3Put {
  readonly bucket: string;
  readonly cacheControl: string | null;
  readonly ifNoneMatch: string | null;
  readonly key: string;
  readonly contentType: string | null;
  readonly metadata: Readonly<Record<string, string>> | null;
}

interface AuthHeaders {
  readonly authorization?: string;
}

function authenticate(
  context: TestContext,
  actor: ApiTestUser | null,
): AuthHeaders {
  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }

  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => {
      return typeof entry === "string";
    })
  );
}

function webhookEventFromAxiomFixture(
  event: Readonly<Record<string, unknown>>,
): AgentEvent {
  const type =
    typeof event.type === "string"
      ? event.type
      : typeof event.eventType === "string"
        ? event.eventType
        : null;
  const sequenceNumber = event.sequenceNumber;
  if (type === null || typeof sequenceNumber !== "number") {
    throw new Error("Chat output fixture requires an event type and sequence");
  }
  return {
    ...(isRecord(event.eventData) ? event.eventData : event),
    type,
    sequenceNumber,
  };
}

function commandInput(command: unknown): Record<string, unknown> {
  if (isRecord(command) && isRecord(command.input)) {
    return command.input;
  }
  return {};
}

function commandName(command: unknown): string {
  return typeof command === "object" && command !== null
    ? command.constructor.name
    : "";
}

function storedS3ObjectResponse(
  objects: readonly StoredS3Object[],
  bucket: string,
  key: string,
) {
  const object = objects.find((candidate) => {
    return candidate.bucket === bucket && candidate.key === key;
  });
  const body =
    object?.body ?? (object ? new Uint8Array(object.size) : undefined);
  return {
    ETag: body
      ? `"${createHash("md5").update(body).digest("hex")}"`
      : undefined,
    ContentLength: object?.size,
    ContentType: object?.contentType,
    LastModified: object ? nowDate() : undefined,
    Metadata: object?.metadata,
    Body: body
      ? {
          async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
            yield body;
          },
        }
      : undefined,
  };
}

function deleteStoredS3Objects(
  objects: StoredS3Object[],
  deletedKeys: string[],
  bucket: string,
  input: Record<string, unknown>,
): void {
  const deletion = isRecord(input.Delete) ? input.Delete : {};
  const deletionObjects = Array.isArray(deletion.Objects)
    ? deletion.Objects
    : [];
  for (const deletionObject of deletionObjects) {
    if (!isRecord(deletionObject)) {
      continue;
    }
    const deletionKey = deletionObject.Key;
    if (typeof deletionKey !== "string") {
      continue;
    }
    deletedKeys.push(deletionKey);
    const index = objects.findIndex((candidate) => {
      return candidate.bucket === bucket && candidate.key === deletionKey;
    });
    if (index !== -1) {
      objects.splice(index, 1);
    }
  }
}

/**
 * Latest run-context snapshot the API ingested into the (mocked) Axiom
 * boundary for a run. The run-context read route queries this dataset back,
 * so replaying the captured ingest keeps the read API working without
 * fabricating snapshot data in tests.
 */
function capturedRunContextSnapshot(
  context: TestContext,
  runId: string,
): readonly Record<string, unknown>[] {
  const calls = context.mocks.axiom.ingest.mock.calls;
  for (let index = calls.length - 1; index >= 0; index--) {
    const call = calls[index];
    if (!call || call[0] !== "run-context" || !Array.isArray(call[1])) {
      continue;
    }
    const events: readonly unknown[] = call[1];
    const snapshot = events.find((entry): entry is Record<string, unknown> => {
      return isRecord(entry) && entry.runId === runId;
    });
    if (snapshot) {
      return [snapshot];
    }
  }
  return [];
}

export function createChatCallbacksApi(context: TestContext) {
  let stagedOutputEvents: AgentEvent[] = [];

  function mockOutputEventQuery(
    events: readonly Record<string, unknown>[],
  ): void {
    const snapshot = [...events];
    context.mocks.axiom.query.mockImplementation((...args: unknown[]) => {
      const apl = typeof args[0] === "string" ? args[0] : "";
      if (apl.includes("['run-context']")) {
        const runId = /runId == "([^"]+)"/.exec(apl)?.[1];
        return Promise.resolve(
          runId ? capturedRunContextSnapshot(context, runId) : [],
        );
      }
      return Promise.resolve(snapshot);
    });
  }

  function pushSubscriptionsClient() {
    return setupAppWithRoutes({
      baseUrl: "https://api.okou.ai",
      context,
      routes: pushSubscriptionsRoutes,
    })(pushSubscriptionsContract);
  }

  function modelPoliciesClient() {
    return setupAppWithRoutes({
      context,
      routes: modelPoliciesRoutes,
    })(modelPoliciesMainContract);
  }

  return {
    failIfChatCallbackRouteIsFetched(): () => number {
      let requests = 0;
      server.use(
        http.post(CHAT_CALLBACK_URL, () => {
          requests += 1;
          return HttpResponse.text(
            "chat callback route should not be fetched",
            {
              status: 500,
            },
          );
        }),
      );
      return () => {
        return requests;
      };
    },

    async registerPushSubscription(actor: ApiTestUser): Promise<string> {
      const endpoint = `https://push.example.test/send/${randomUUID()}`;
      await accept(
        pushSubscriptionsClient().register({
          headers: authenticate(context, actor),
          body: {
            endpoint,
            keys: { p256dh: "bdd-p256dh", auth: "bdd-auth" },
          },
        }),
        [201],
      );
      return endpoint;
    },

    enableVapid(): void {
      mockOptionalEnv("VAPID_PUBLIC_KEY", "bdd-vapid-public-key");
      mockOptionalEnv("VAPID_PRIVATE_KEY", "bdd-vapid-private-key");
    },

    disableVapid(): void {
      mockOptionalEnv("VAPID_PUBLIC_KEY", undefined);
      mockOptionalEnv("VAPID_PRIVATE_KEY", undefined);
    },

    /** Replaces the org model-first policy set through the public route. */
    async updateOrgModelPolicies(
      actor: ApiTestUser,
      policies: OrgModelPolicies,
    ): Promise<void> {
      const snapshot = await accept(
        modelPoliciesClient().list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      await accept(
        modelPoliciesClient().update({
          headers: authenticate(context, actor),
          body: { policies, revision: snapshot.body.revision },
        }),
        [200],
      );
    },

    /**
     * Single OpenRouter completions endpoint serving title, follow-up, run
     * summary, and notification summary prompts. The handler branches on the
     * system prompt and returns the completion text.
     */
    mockOpenRouterCompletions(
      handler: (
        body: OpenRouterCompletionBody,
      ) => OpenRouterCompletionResult | Promise<OpenRouterCompletionResult>,
    ): void {
      server.use(
        http.post(OPENROUTER_COMPLETIONS_URL, async ({ request }) => {
          const body = openRouterCompletionBodySchema.parse(
            await request.json(),
          );
          const contractError = openRouterModelContractError(body);
          if (contractError) {
            return contractError;
          }
          const result = await handler(body);
          if (result instanceof Response) {
            return result;
          }
          return HttpResponse.json({
            choices: [
              typeof result === "string"
                ? { finish_reason: "stop", message: { content: result } }
                : {
                    finish_reason: result.finishReason,
                    native_finish_reason: "MAX_TOKENS",
                    message: { content: result.content },
                  },
            ],
          });
        }),
      );
    },

    mockOpenRouterFailure(): void {
      server.use(
        http.post(OPENROUTER_COMPLETIONS_URL, () => {
          return new HttpResponse("Internal Server Error", { status: 500 });
        }),
      );
    },

    /**
     * Stages output for the canonical chat_events DB projection. Run-context
     * queries replay the snapshot the API itself ingested at run creation.
     */
    mockChatOutputEvents(events: readonly Record<string, unknown>[]): void {
      stagedOutputEvents = events.map(webhookEventFromAxiomFixture);
      mockOutputEventQuery(events);
    },

    consumeMockChatOutputEvents(): AgentEvent[] {
      const events = stagedOutputEvents;
      stagedOutputEvents = [];
      return events;
    },

    /**
     * Object-storage fake for chat chains: session-history blobs download
     * with deterministic content (so session resume works end to end),
     * registered upload objects appear in prefix listings (upload complete),
     * and every other command acks like the plain storage-write mock.
     */
    acceptChatObjectStorage(): {
      addObject(object: StoredS3Object): void;
      readonly deletedKeys: readonly string[];
      readonly puts: readonly CapturedS3Put[];
      readonly rejectedPuts: readonly CapturedS3Put[];
      rejectNextImmutablePutAsExisting(contentType: string): void;
    } {
      const objects: StoredS3Object[] = [];
      const deletedKeys: string[] = [];
      const puts: CapturedS3Put[] = [];
      const rejectedPuts: CapturedS3Put[] = [];
      let rejectNextImmutablePutContentType: string | null = null;
      context.mocks.s3.send.mockImplementation((...args: unknown[]) => {
        const input = commandInput(args[0]);
        const key = typeof input.Key === "string" ? input.Key : "";
        if (key.startsWith("blobs/") && key.endsWith(".blob")) {
          const body = sessionHistoryBlobBodyForKey(context, key);
          return Promise.resolve({
            Body: {
              async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
                if (body) {
                  yield body;
                }
              },
            },
          });
        }
        const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
        const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
        const name = commandName(args[0]);
        if (name === "PutObjectCommand") {
          const put: CapturedS3Put = {
            bucket,
            cacheControl:
              typeof input.CacheControl === "string"
                ? input.CacheControl
                : null,
            ifNoneMatch:
              typeof input.IfNoneMatch === "string" ? input.IfNoneMatch : null,
            key,
            contentType:
              typeof input.ContentType === "string" ? input.ContentType : null,
            metadata: isStringRecord(input.Metadata) ? input.Metadata : null,
          };
          puts.push(put);
          if (
            rejectNextImmutablePutContentType !== null &&
            input.ContentType === rejectNextImmutablePutContentType &&
            input.IfNoneMatch === "*"
          ) {
            rejectNextImmutablePutContentType = null;
            rejectedPuts.push(put);
            return Promise.reject(
              Object.assign(new Error("immutable object already exists"), {
                name: "PreconditionFailed",
                $metadata: { httpStatusCode: 412 },
              }),
            );
          }
        }
        if (name === "HeadObjectCommand") {
          return Promise.resolve(storedS3ObjectResponse(objects, bucket, key));
        }
        if (name === "GetObjectCommand") {
          return Promise.resolve(storedS3ObjectResponse(objects, bucket, key));
        }
        if (name === "DeleteObjectsCommand") {
          deleteStoredS3Objects(objects, deletedKeys, bucket, input);
          return Promise.resolve({});
        }
        if (prefix !== "") {
          const contents = objects
            .filter((object) => {
              return object.bucket === bucket && object.key.startsWith(prefix);
            })
            .map((object) => {
              return {
                Key: object.key,
                Size: object.size,
                LastModified: nowDate(),
              };
            });
          return Promise.resolve({ Contents: contents });
        }
        return Promise.resolve({});
      });
      installArtifactReferenceStorage(context);
      return {
        addObject(object: StoredS3Object): void {
          objects.push(object);
        },
        deletedKeys,
        puts,
        rejectedPuts,
        rejectNextImmutablePutAsExisting(contentType: string): void {
          rejectNextImmutablePutContentType = contentType;
        },
      };
    },
  };
}
