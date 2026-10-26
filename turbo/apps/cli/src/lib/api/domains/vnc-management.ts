import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  vncConnectionsContract,
  vncSecuritySchema,
} from "@okouai/api-contracts/contracts/vnc-connections";
import {
  vncAuthenticationSchema,
  vncCredentialsContract,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import {
  array,
  int,
  literal,
  object,
  string,
  union,
  uuid,
  enum as zEnum,
  type output,
  type ZodType,
} from "zod";

import { vncRsaServerKeyPinSchema } from "@okouai/api-contracts/contracts/vnc-rsa-aes";
import { getClientConfig } from "../core/client-factory";
import { handleManagementError } from "../../management-input";

// Select public identity/trust metadata rather than serializing API objects.
// Provider credentials, CA bundles and injected secret fields are stripped at
// every object boundary before command output.
const trustMetadataSchema = object({ mode: zEnum(["system", "custom_ca"]) });
const nonAccessRoutes = [
  object({ type: literal("direct") }),
  object({ type: literal("ssh"), connectionId: uuid() }),
  object({ type: literal("tailscale"), configId: uuid() }),
  object({ type: literal("tailscale"), needsRebind: literal(true) }),
] as const;
const kdcRouteMetadataSchema = union([
  ...nonAccessRoutes,
  object({ type: literal("cloudflare_access"), configId: uuid() }),
  object({
    type: literal("cloudflare_access"),
    needsRebind: literal(true),
  }),
]);
const vncRouteMetadataSchema = union([
  ...nonAccessRoutes,
  object({
    type: literal("cloudflare_access"),
    configId: uuid(),
    originTls: object({
      serverName: string(),
      trust: trustMetadataSchema,
    }).optional(),
  }),
  object({
    type: literal("cloudflare_access"),
    needsRebind: literal(true),
    originTls: object({
      serverName: string(),
      trust: trustMetadataSchema,
    }).optional(),
  }),
]);
const hostMetadataSchema = object({
  id: uuid(),
  displayName: string(),
  host: string(),
  port: int(),
  credentialId: uuid().optional(),
  credentialName: string().optional(),
  security: object({
    type: union(
      vncSecuritySchema.options.map((option) => {
        return option.shape.type;
      }),
    ),
    serverName: string().optional(),
    serverKeySha256: vncRsaServerKeyPinSchema.optional(),
    service: object({
      realm: string(),
      components: array(string()),
    }).optional(),
    trust: trustMetadataSchema.optional(),
    kdc: object({
      host: string(),
      port: int(),
      transport: kdcRouteMetadataSchema,
      ticketLifetimeSeconds: int(),
      renewableLifetimeSeconds: int(),
    }).optional(),
  }),
  transport: vncRouteMetadataSchema.optional(),
  generation: int().positive(),
  createdAt: string(),
  updatedAt: string(),
});
const credentialMetadataSchema = object({
  id: uuid(),
  name: string(),
  authMethod: union(
    vncAuthenticationSchema.options.map((option) => {
      return option.shape.method;
    }),
  ),
  revision: int().positive(),
  createdAt: string(),
  updatedAt: string(),
  hosts: array(object({ id: uuid(), displayName: string() })),
});

async function request<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error(
      "VNC management request failed. Check connectivity and authentication; response details are not displayed.",
    );
  }
}

function safeMetadata<T extends ZodType>(schema: T, body: unknown): output<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      "Invalid VNC management response. Response details are not displayed.",
    );
  }
  return parsed.data;
}

export async function listConfiguredVncHosts() {
  const client = initClient(vncConnectionsContract, await getClientConfig());
  const result = await request(() => {
    return client.list({});
  });
  if (result.status !== 200)
    handleManagementError(result, "Cannot list configured VNC hosts");
  return safeMetadata(
    object({ connections: array(hostMetadataSchema) }),
    result.body,
  );
}

export async function createConfiguredVncHost(
  body: output<typeof vncConnectionsContract.create.body>,
) {
  const client = initClient(vncConnectionsContract, await getClientConfig());
  const result = await request(() => {
    return client.create({ body });
  });
  if (result.status === 204) return { id: body.id };
  if (result.status !== 201)
    handleManagementError(result, "Cannot create VNC host");
  return safeMetadata(hostMetadataSchema, result.body);
}

export async function updateConfiguredVncHost(
  connectionId: string,
  body: output<typeof vncConnectionsContract.update.body>,
) {
  const client = initClient(vncConnectionsContract, await getClientConfig());
  const result = await request(() => {
    return client.update({ params: { connectionId }, body });
  });
  if (result.status !== 200)
    handleManagementError(result, "Cannot update VNC host");
  return safeMetadata(hostMetadataSchema, result.body);
}

export async function deleteConfiguredVncHost(
  connectionId: string,
  body: output<typeof vncConnectionsContract.delete.body>,
) {
  const client = initClient(vncConnectionsContract, await getClientConfig());
  const result = await request(() => {
    return client.delete({ params: { connectionId }, body });
  });
  if (result.status !== 204)
    handleManagementError(result, "Cannot delete VNC host");
  return { id: connectionId, deleted: true };
}

export async function listVncCredentials() {
  const client = initClient(vncCredentialsContract, await getClientConfig());
  const result = await request(() => {
    return client.list({});
  });
  if (result.status !== 200)
    handleManagementError(result, "Cannot list VNC credentials");
  return safeMetadata(
    object({ credentials: array(credentialMetadataSchema) }),
    result.body,
  );
}

export async function createVncCredential(
  body: output<typeof vncCredentialsContract.create.body>,
) {
  const client = initClient(vncCredentialsContract, await getClientConfig());
  const result = await request(() => {
    return client.create({ body });
  });
  if (result.status === 204) return { id: body.id };
  if (result.status !== 201)
    handleManagementError(result, "Cannot create VNC credential");
  return safeMetadata(credentialMetadataSchema, result.body);
}

export async function updateVncCredential(
  credentialId: string,
  body: output<typeof vncCredentialsContract.update.body>,
) {
  const client = initClient(vncCredentialsContract, await getClientConfig());
  const result = await request(() => {
    return client.update({ params: { credentialId }, body });
  });
  if (result.status !== 200)
    handleManagementError(result, "Cannot update VNC credential");
  return safeMetadata(credentialMetadataSchema, result.body);
}

export async function deleteVncCredential(
  credentialId: string,
  body: output<typeof vncCredentialsContract.delete.body>,
) {
  const client = initClient(vncCredentialsContract, await getClientConfig());
  const result = await request(() => {
    return client.delete({ params: { credentialId }, body });
  });
  if (result.status !== 204)
    handleManagementError(result, "Cannot delete VNC credential");
  return { id: credentialId, deleted: true };
}
