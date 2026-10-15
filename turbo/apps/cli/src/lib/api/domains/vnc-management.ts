import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  vncConnectionsContract,
  vncSecuritySchema,
} from "@okouai/api-contracts/contracts/vnc-connections";
import {
  vncAuthenticationSchema,
  vncCredentialsContract,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import { z } from "zod";
import { vncRsaServerKeyPinSchema } from "@okouai/api-contracts/contracts/vnc-rsa-aes";
import { getClientConfig } from "../core/client-factory";
import { handleManagementError } from "../../management-input";

// Select public identity/trust metadata rather than serializing API objects.
// Provider credentials, CA bundles and injected secret fields are stripped at
// every object boundary before command output.
const trustMetadataSchema = z.object({ mode: z.enum(["system", "custom_ca"]) });
const nonAccessRoutes = [
  z.object({ type: z.literal("direct") }),
  z.object({ type: z.literal("ssh"), connectionId: z.uuid() }),
  z.object({ type: z.literal("tailscale"), configId: z.uuid() }),
  z.object({ type: z.literal("tailscale"), needsRebind: z.literal(true) }),
] as const;
const kdcRouteMetadataSchema = z.union([
  ...nonAccessRoutes,
  z.object({ type: z.literal("cloudflare_access"), configId: z.uuid() }),
  z.object({
    type: z.literal("cloudflare_access"),
    needsRebind: z.literal(true),
  }),
]);
export const vncRouteMetadataSchema = z.union([
  ...nonAccessRoutes,
  z.object({
    type: z.literal("cloudflare_access"),
    configId: z.uuid(),
    originTls: z
      .object({ serverName: z.string(), trust: trustMetadataSchema })
      .optional(),
  }),
  z.object({
    type: z.literal("cloudflare_access"),
    needsRebind: z.literal(true),
    originTls: z
      .object({ serverName: z.string(), trust: trustMetadataSchema })
      .optional(),
  }),
]);
const hostMetadataSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  host: z.string(),
  port: z.int(),
  credentialId: z.uuid().optional(),
  credentialName: z.string().optional(),
  security: z.object({
    type: z.union(
      vncSecuritySchema.options.map((option) => {
        return option.shape.type;
      }),
    ),
    serverName: z.string().optional(),
    serverKeySha256: vncRsaServerKeyPinSchema.optional(),
    service: z
      .object({ realm: z.string(), components: z.array(z.string()) })
      .optional(),
    trust: trustMetadataSchema.optional(),
    kdc: z
      .object({
        host: z.string(),
        port: z.int(),
        transport: kdcRouteMetadataSchema,
        ticketLifetimeSeconds: z.int(),
        renewableLifetimeSeconds: z.int(),
      })
      .optional(),
  }),
  transport: vncRouteMetadataSchema.optional(),
  generation: z.int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const credentialMetadataSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  authMethod: z.union(
    vncAuthenticationSchema.options.map((option) => {
      return option.shape.method;
    }),
  ),
  revision: z.int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  hosts: z.array(z.object({ id: z.uuid(), displayName: z.string() })),
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

function safeMetadata<T extends z.ZodType>(
  schema: T,
  body: unknown,
): z.output<T> {
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
    z.object({ connections: z.array(hostMetadataSchema) }),
    result.body,
  );
}

export async function createConfiguredVncHost(
  body: z.output<typeof vncConnectionsContract.create.body>,
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
  body: z.output<typeof vncConnectionsContract.update.body>,
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
  body: z.output<typeof vncConnectionsContract.delete.body>,
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
    z.object({ credentials: z.array(credentialMetadataSchema) }),
    result.body,
  );
}

export async function createVncCredential(
  body: z.output<typeof vncCredentialsContract.create.body>,
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
  body: z.output<typeof vncCredentialsContract.update.body>,
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
  body: z.output<typeof vncCredentialsContract.delete.body>,
) {
  const client = initClient(vncCredentialsContract, await getClientConfig());
  const result = await request(() => {
    return client.delete({ params: { credentialId }, body });
  });
  if (result.status !== 204)
    handleManagementError(result, "Cannot delete VNC credential");
  return { id: credentialId, deleted: true };
}
