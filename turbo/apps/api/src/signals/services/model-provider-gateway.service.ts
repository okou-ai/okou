import { command, computed } from "ccstate";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, notExists, notInArray } from "drizzle-orm";
import {
  getFrameworkForType,
  modelProviderTypeSchema,
  normalizeBuiltInModelId,
  RETIRED_RUN_MODEL_MESSAGE,
} from "@okouai/api-contracts/contracts/model-providers";
import type {
  CreateModelProviderConnectionRequest,
  ModelProviderConnectionResponse,
  ModelProviderSurfaceProtocol,
  UpdateModelProviderConnectionRequest,
} from "@okouai/api-contracts/contracts/model-provider-gateways";
import { canonicalizeFirewallBaseUrl } from "@okouai/connectors/firewall-types";
import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@okouai/db/schema/model-provider-gateway";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { secrets } from "@okouai/db/schema/secret";
import { badRequestMessage, notFound } from "../../lib/error";
import { db$, writeDb$ } from "../external/db";
import { publishModelPoliciesChangedForOrgSafely } from "../external/realtime";
import { nowDate } from "../../lib/time";
import { safeSync } from "../utils";
import { encryptStoredSecretValue } from "./crypto.utils";
import {
  catalogBuiltInCandidates,
  isCatalogModelRunnable,
  resolveCatalogModel,
  type ModelCatalog,
  modelCatalog$,
} from "./model-catalog.service";

const ORG_SENTINEL_USER_ID = "__org__";
const SECRET_PLACEHOLDER = "{{secret}}";
const HEADER_NAME_REGEX = /^[A-Za-z][A-Za-z0-9-]*$/;

/** Pure condition; a missing metadata row reads as Custom, matching every other mode check. */
function autoModeOrg(orgId: string) {
  return and(eq(orgMetadata.orgId, orgId), eq(orgMetadata.modelMode, "auto"));
}

type BadRequestResponse = ReturnType<typeof badRequestMessage>;
type NotFoundResponse = ReturnType<typeof notFound>;
type ConnectionInput =
  | CreateModelProviderConnectionRequest
  | UpdateModelProviderConnectionRequest;

interface ValidatedSurface {
  readonly protocol: ModelProviderSurfaceProtocol;
  readonly apiBaseUrl: string;
  readonly authHeaderName: string;
  readonly authHeaderTemplate: string;
  readonly modelMappings: Record<string, string>;
}

interface ValidatedConnection {
  readonly displayName: string;
  readonly surfaces: readonly ValidatedSurface[];
}

function isProtectedHeaderName(name: string): boolean {
  return (
    name === "connection" ||
    name === "content-length" ||
    name === "host" ||
    name === "proxy-authorization" ||
    name === "te" ||
    name === "trailer" ||
    name === "transfer-encoding" ||
    name === "upgrade"
  );
}

function isBadRequest(value: unknown): value is BadRequestResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === 400
  );
}

function normalizeApiBaseUrl(
  raw: string,
  protocol: ModelProviderSurfaceProtocol,
): string | BadRequestResponse {
  let value = raw.trim().replace(/\/+$/, "");
  const endpointSuffix =
    protocol === "anthropic-messages" ? "/v1/messages" : "/responses";
  if (value.endsWith(endpointSuffix)) {
    value = value.slice(0, -endpointSuffix.length);
  }
  value = value.replace(/\/+$/, "");

  const parsed = safeSync(() => {
    return new URL(value);
  });
  if ("error" in parsed) {
    return badRequestMessage(`Invalid API base URL: ${raw}`);
  }
  if (parsed.ok.protocol !== "https:") {
    return badRequestMessage("Model provider API base URLs must use https://");
  }
  if (
    parsed.ok.username ||
    parsed.ok.password ||
    parsed.ok.search ||
    parsed.ok.hash
  ) {
    return badRequestMessage(
      "Model provider API base URLs cannot contain credentials, query strings, or fragments",
    );
  }

  const canonical = safeSync(() => {
    return canonicalizeFirewallBaseUrl(value, "custom model provider");
  });
  if ("error" in canonical) {
    return badRequestMessage(
      canonical.error instanceof Error
        ? canonical.error.message
        : `Invalid API base URL: ${raw}`,
    );
  }
  return canonical.ok.replace(/\/+$/, "");
}

function validateHeader(args: {
  readonly name: string;
  readonly template: string;
}):
  | {
      readonly name: string;
      readonly template: string;
    }
  | BadRequestResponse {
  const name = args.name.trim();
  if (
    name.length > 128 ||
    !HEADER_NAME_REGEX.test(name) ||
    isProtectedHeaderName(name.toLowerCase())
  ) {
    return badRequestMessage(`Unsupported authentication header: ${args.name}`);
  }
  if (args.template.includes("\r") || args.template.includes("\n")) {
    return badRequestMessage(
      "Authentication header templates cannot contain line breaks",
    );
  }
  if (args.template.length > 1024) {
    return badRequestMessage(
      "Authentication header templates cannot exceed 1024 characters",
    );
  }
  if (args.template.split(SECRET_PLACEHOLDER).length !== 2) {
    return badRequestMessage(
      `Authentication header templates must contain ${SECRET_PLACEHOLDER} exactly once`,
    );
  }
  const staticTemplate = args.template.replace(SECRET_PLACEHOLDER, "");
  if (staticTemplate.includes("{{") || staticTemplate.includes("}}")) {
    return badRequestMessage(
      "Authentication header templates cannot contain other template references",
    );
  }
  return { name, template: args.template };
}

/**
 * A gateway can serve a catalog model that runs directly (active, with an
 * enabled route) whose primary Built-in route speaks the surface's protocol.
 */
function protocolSupportsModel(
  catalog: ModelCatalog,
  protocol: ModelProviderSurfaceProtocol,
  model: string,
): boolean {
  if (!isCatalogModelRunnable(catalog, model)) {
    return false;
  }
  const [primary] = catalogBuiltInCandidates(catalog, model);
  const concrete = modelProviderTypeSchema.safeParse(
    primary?.concreteProviderType,
  );
  if (!concrete.success) {
    return false;
  }
  const framework = getFrameworkForType(concrete.data);
  return protocol === "anthropic-messages"
    ? framework === "claude-code"
    : framework === "codex";
}

function validateMappings(
  catalog: ModelCatalog,
  protocol: ModelProviderSurfaceProtocol,
  mappings: Record<string, string>,
): Record<string, string> | BadRequestResponse {
  const normalized: Record<string, string> = {};
  for (const [model, upstream] of Object.entries(mappings)) {
    if (!protocolSupportsModel(catalog, protocol, model)) {
      return badRequestMessage(
        `Model "${model}" is not compatible with ${protocol}`,
      );
    }
    const upstreamModel = upstream.trim();
    if (!upstreamModel) {
      return badRequestMessage(`Upstream model for "${model}" cannot be empty`);
    }
    // A provider-prefixed alias of a retired catalog model is still retired.
    const upstreamCatalogModel = normalizeBuiltInModelId(
      upstreamModel.toLowerCase(),
    );
    if (
      resolveCatalogModel(catalog, upstreamCatalogModel).kind === "replaced"
    ) {
      return badRequestMessage(RETIRED_RUN_MODEL_MESSAGE);
    }
    normalized[model] = upstreamModel;
  }
  return normalized;
}

function validateConnectionInput(
  catalog: ModelCatalog,
  input: ConnectionInput,
): ValidatedConnection | BadRequestResponse {
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 128) {
    return badRequestMessage(
      "Connection name must contain between 1 and 128 characters",
    );
  }
  if (input.secret !== undefined && !input.secret.trim()) {
    return badRequestMessage("API key cannot be empty");
  }

  const seenProtocols = new Set<ModelProviderSurfaceProtocol>();
  const surfaces: ValidatedSurface[] = [];
  for (const surface of input.surfaces) {
    if (seenProtocols.has(surface.protocol)) {
      return badRequestMessage(`Duplicate protocol: ${surface.protocol}`);
    }
    seenProtocols.add(surface.protocol);

    const apiBaseUrl = normalizeApiBaseUrl(
      surface.apiBaseUrl,
      surface.protocol,
    );
    if (isBadRequest(apiBaseUrl)) {
      return apiBaseUrl;
    }
    const header = validateHeader({
      name: surface.authHeaderName,
      template: surface.authHeaderTemplate,
    });
    if (isBadRequest(header)) {
      return header;
    }
    const modelMappings = validateMappings(
      catalog,
      surface.protocol,
      surface.modelMappings,
    );
    if (isBadRequest(modelMappings)) {
      return modelMappings;
    }
    surfaces.push({
      protocol: surface.protocol,
      apiBaseUrl,
      authHeaderName: header.name,
      authHeaderTemplate: header.template,
      modelMappings,
    });
  }
  return { displayName, surfaces };
}

function secretName(connectionId: string): string {
  return `MODEL_PROVIDER_GATEWAY_${connectionId.replaceAll("-", "").toUpperCase()}`;
}

function connectionResponse(
  connection: typeof modelProviderConnections.$inferSelect,
  surfaces: readonly (typeof modelProviderSurfaces.$inferSelect)[],
): ModelProviderConnectionResponse {
  return {
    id: connection.id,
    displayName: connection.displayName,
    surfaces: surfaces.map((surface) => {
      return {
        id: surface.id,
        protocol:
          surface.protocol === "anthropic-messages"
            ? "anthropic-messages"
            : "openai-responses",
        apiBaseUrl: surface.apiBaseUrl,
        authHeaderName: surface.authHeaderName,
        authHeaderTemplate: surface.authHeaderTemplate,
        modelMappings: surface.modelMappings,
        createdAt: surface.createdAt.toISOString(),
        updatedAt: surface.updatedAt.toISOString(),
      };
    }),
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  };
}

const loadConnection$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly connectionId: string },
    signal: AbortSignal,
  ): Promise<ModelProviderConnectionResponse | null> => {
    const db = set(writeDb$);
    const [connection] = await db
      .select()
      .from(modelProviderConnections)
      .where(
        and(
          eq(modelProviderConnections.id, args.connectionId),
          eq(modelProviderConnections.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!connection) {
      return null;
    }
    const surfaces = await db
      .select()
      .from(modelProviderSurfaces)
      .where(eq(modelProviderSurfaces.connectionId, connection.id))
      .orderBy(modelProviderSurfaces.protocol);
    signal.throwIfAborted();
    return connectionResponse(connection, surfaces);
  },
);

export const modelProviderConnectionsForOrg = (orgId: string) => {
  return computed(async (get) => {
    const db = get(db$);
    const [org] = await db
      .select({ mode: orgMetadata.modelMode })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    if (org?.mode === "auto") {
      return { connections: [] };
    }
    const connections = await db
      .select()
      .from(modelProviderConnections)
      .where(eq(modelProviderConnections.orgId, orgId))
      .orderBy(modelProviderConnections.displayName);
    const surfaces =
      connections.length === 0
        ? []
        : await db
            .select()
            .from(modelProviderSurfaces)
            .where(
              inArray(
                modelProviderSurfaces.connectionId,
                connections.map((connection) => {
                  return connection.id;
                }),
              ),
            )
            .orderBy(modelProviderSurfaces.protocol);
    return {
      connections: connections.map((connection) => {
        return connectionResponse(
          connection,
          surfaces.filter((surface) => {
            return surface.connectionId === connection.id;
          }),
        );
      }),
    };
  });
};

export const createModelProviderConnection$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly input: CreateModelProviderConnectionRequest;
    },
    signal: AbortSignal,
  ): Promise<ModelProviderConnectionResponse | BadRequestResponse> => {
    const validated = validateConnectionInput(
      await get(modelCatalog$),
      args.input,
    );
    if (isBadRequest(validated)) {
      return validated;
    }
    const encryptedValue = await encryptStoredSecretValue(args.input.secret);
    signal.throwIfAborted();
    const db = set(writeDb$);
    const connectionId = randomUUID();
    const created = await db.transaction(async (tx) => {
      const [autoOrg] = await tx
        .select({ orgId: orgMetadata.orgId })
        .from(orgMetadata)
        .where(autoModeOrg(args.orgId))
        .limit(1);
      if (autoOrg) {
        return false;
      }
      const [secret] = await tx
        .insert(secrets)
        .values({
          name: secretName(connectionId),
          encryptedValue,
          description: `Custom model provider secret for ${validated.displayName}`,
          type: "model-provider",
          userId: ORG_SENTINEL_USER_ID,
          orgId: args.orgId,
        })
        .returning({ id: secrets.id });
      if (!secret) {
        throw new Error("Expected custom model provider secret insert");
      }
      await tx.insert(modelProviderConnections).values({
        id: connectionId,
        orgId: args.orgId,
        displayName: validated.displayName,
        secretId: secret.id,
      });
      await tx.insert(modelProviderSurfaces).values(
        validated.surfaces.map((surface) => {
          return { connectionId, ...surface };
        }),
      );
      return true;
    });
    signal.throwIfAborted();
    if (!created) {
      return badRequestMessage(
        "Provider connections cannot be configured in Auto mode",
      );
    }
    const connection = await set(
      loadConnection$,
      { orgId: args.orgId, connectionId },
      signal,
    );
    signal.throwIfAborted();
    if (!connection) {
      throw new Error("Expected custom model provider connection insert");
    }
    await publishModelPoliciesChangedForOrgSafely(args.orgId);
    signal.throwIfAborted();
    return connection;
  },
);

export const updateModelProviderConnection$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly connectionId: string;
      readonly input: UpdateModelProviderConnectionRequest;
    },
    signal: AbortSignal,
  ): Promise<
    ModelProviderConnectionResponse | BadRequestResponse | NotFoundResponse
  > => {
    const validated = validateConnectionInput(
      await get(modelCatalog$),
      args.input,
    );
    if (isBadRequest(validated)) {
      return validated;
    }
    const encryptedValue = args.input.secret
      ? await encryptStoredSecretValue(args.input.secret)
      : null;
    signal.throwIfAborted();
    const db = set(writeDb$);
    const result = await db.transaction(async (tx) => {
      const [autoOrg] = await tx
        .select({ orgId: orgMetadata.orgId })
        .from(orgMetadata)
        .where(autoModeOrg(args.orgId))
        .limit(1);
      if (autoOrg) {
        return "auto";
      }
      const [connection] = await tx
        .select({ secretId: modelProviderConnections.secretId })
        .from(modelProviderConnections)
        .where(
          and(
            eq(modelProviderConnections.id, args.connectionId),
            eq(modelProviderConnections.orgId, args.orgId),
          ),
        )
        .limit(1);
      if (!connection) {
        return false;
      }
      await tx
        .update(modelProviderConnections)
        .set({ displayName: validated.displayName, updatedAt: nowDate() })
        .where(eq(modelProviderConnections.id, args.connectionId));
      await tx
        .update(secrets)
        .set({
          ...(encryptedValue ? { encryptedValue } : {}),
          description: `Custom model provider secret for ${validated.displayName}`,
          updatedAt: nowDate(),
        })
        .where(eq(secrets.id, connection.secretId));
      for (const surface of validated.surfaces) {
        await tx
          .insert(modelProviderSurfaces)
          .values({ connectionId: args.connectionId, ...surface })
          .onConflictDoUpdate({
            target: [
              modelProviderSurfaces.connectionId,
              modelProviderSurfaces.protocol,
            ],
            set: { ...surface, updatedAt: nowDate() },
          });
      }
      await tx.delete(modelProviderSurfaces).where(
        and(
          eq(modelProviderSurfaces.connectionId, args.connectionId),
          notInArray(
            modelProviderSurfaces.protocol,
            validated.surfaces.map((surface) => {
              return surface.protocol;
            }),
          ),
        ),
      );
      return true;
    });
    signal.throwIfAborted();
    if (result === "auto") {
      return badRequestMessage(
        "Provider connections cannot be configured in Auto mode",
      );
    }
    if (!result) {
      return notFound("Resource not found");
    }
    const updated = await set(
      loadConnection$,
      { orgId: args.orgId, connectionId: args.connectionId },
      signal,
    );
    signal.throwIfAborted();
    if (!updated) {
      throw new Error("Expected custom model provider connection update");
    }
    await publishModelPoliciesChangedForOrgSafely(args.orgId);
    signal.throwIfAborted();
    return updated;
  },
);

export const deleteModelProviderConnection$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly connectionId: string },
    signal: AbortSignal,
  ): Promise<NotFoundResponse | undefined> => {
    const db = set(writeDb$);
    const deleted = await db.transaction(async (tx) => {
      const [connection] = await tx
        .delete(modelProviderConnections)
        .where(
          and(
            eq(modelProviderConnections.id, args.connectionId),
            eq(modelProviderConnections.orgId, args.orgId),
          ),
        )
        .returning({ secretId: modelProviderConnections.secretId });
      if (!connection) {
        return false;
      }
      // Migrated connections may share a secret with a legacy provider while
      // both schemas are live. Remove the secret only after every reference is
      // gone so deleting the new connection cannot cascade-delete old rows.
      await tx
        .delete(secrets)
        .where(
          and(
            eq(secrets.id, connection.secretId),
            notExists(
              tx
                .select({ id: modelProviders.id })
                .from(modelProviders)
                .where(eq(modelProviders.secretId, connection.secretId)),
            ),
            notExists(
              tx
                .select({ id: modelProviderConnections.id })
                .from(modelProviderConnections)
                .where(
                  eq(modelProviderConnections.secretId, connection.secretId),
                ),
            ),
          ),
        );
      return true;
    });
    signal.throwIfAborted();
    if (!deleted) {
      return notFound("Resource not found");
    }
    await publishModelPoliciesChangedForOrgSafely(args.orgId);
    signal.throwIfAborted();
    return undefined;
  },
);
