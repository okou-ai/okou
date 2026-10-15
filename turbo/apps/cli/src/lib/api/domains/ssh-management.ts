import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  sshConnectionsContract,
  sshConnectionMetadataSchema,
  type CreateSshConnectionRequest,
  type UpdateSshConnectionRequest,
} from "@okouai/api-contracts/contracts/ssh-connections";
import {
  sshCredentialsContract,
  sshCredentialResponseSchema,
  type CreateSshCredentialRequest,
  type UpdateSshCredentialRequest,
} from "@okouai/api-contracts/contracts/ssh-credentials";
import { z } from "zod";
import { getClientConfig } from "../core/client-factory";
import { handleManagementError } from "../../management-input";

// Parse into a whitelist, including nested objects. Never serialize API bodies.
const transportSchema = z.union([
  z.object({ type: z.literal("cloudflare_access"), configId: z.uuid() }),
  z.object({ type: z.literal("tailscale"), configId: z.uuid() }),
  z.object({
    type: z.literal("cloudflare_access"),
    needsRebind: z.literal(true),
  }),
  z.object({ type: z.literal("tailscale"), needsRebind: z.literal(true) }),
]);
const credentialHostMetadataSchema = sshConnectionMetadataSchema
  .pick({
    id: true,
    displayName: true,
    host: true,
    port: true,
    credentialId: true,
    credentialName: true,
    generation: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    learnedHostKey: z
      .object({ algorithm: z.string(), fingerprint: z.string() })
      .nullable(),
    transport: transportSchema.optional(),
  })
  .strip();
const hostMetadataSchema = z.union([
  credentialHostMetadataSchema,
  credentialHostMetadataSchema
    .omit({ credentialId: true, credentialName: true })
    .extend({
      username: z.string(),
      transport: z.union([
        z.object({ type: z.literal("tailscale_ssh"), configId: z.uuid() }),
        z.object({
          type: z.literal("tailscale_ssh"),
          needsRebind: z.literal(true),
        }),
      ]),
    }),
]);
const credentialMetadataSchema = sshCredentialResponseSchema
  .pick({
    id: true,
    name: true,
    authMethod: true,
    revision: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    hosts: z.array(z.object({ id: z.uuid(), displayName: z.string() })),
  })
  .strip();

function metadata<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new Error("Invalid SSH management metadata response.");
  return result.data;
}

// A malformed JSON response or network error must not expose reflected input.
async function managementRequest<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch {
    throw new Error(
      "Cannot read SSH management response. Check the API connection and authentication.",
    );
  }
}

export async function listConfiguredSshHosts() {
  const client = initClient(sshConnectionsContract, await getClientConfig());
  const result = await managementRequest(() => {
    return client.list();
  });
  if (result.status !== 200)
    handleManagementError(result, "Cannot list configured SSH hosts");
  return metadata(
    z.object({ connections: z.array(hostMetadataSchema) }),
    result.body,
  );
}

export async function showConfiguredSshHost(id: string) {
  const inventory = await listConfiguredSshHosts();
  const host = inventory.connections.find((item) => {
    return item.id.toLowerCase() === id.toLowerCase();
  });
  if (!host)
    throw new Error(
      "SSH host not found. Refresh okou ssh host list --scope configured.",
    );
  return host;
}

export async function createSshHost(body: CreateSshConnectionRequest) {
  const client = initClient(sshConnectionsContract, await getClientConfig());
  const result = await managementRequest(() => {
    return client.create({ body });
  });
  if (result.status === 204) return { id: body.id, outcome: "created" };
  if (result.status !== 201)
    handleManagementError(result, "Cannot create SSH host");
  return metadata(hostMetadataSchema, result.body);
}

export async function updateSshHost(
  id: string,
  body: UpdateSshConnectionRequest,
) {
  const client = initClient(sshConnectionsContract, await getClientConfig());
  const result = await managementRequest(() => {
    return client.update({ params: { connectionId: id }, body });
  });
  if (result.status !== 200)
    handleManagementError(result, "Cannot update SSH host");
  return metadata(hostMetadataSchema, result.body);
}

export async function deleteSshHost(id: string, expectedGeneration: number) {
  const client = initClient(sshConnectionsContract, await getClientConfig());
  const result = await managementRequest(() => {
    return client.delete({
      params: { connectionId: id },
      body: { expectedGeneration },
    });
  });
  if (result.status === 409) {
    handleManagementError(
      result,
      `Cannot delete SSH host. Review it with okou ssh host show ${id}, then explicitly delete with the reviewed expectedGeneration`,
    );
  }
  if (result.status !== 204)
    handleManagementError(result, "Cannot delete SSH host");
  return { id, outcome: "deleted" };
}

export async function resetSshHostKey(id: string, expectedGeneration: number) {
  const client = initClient(sshConnectionsContract, await getClientConfig());
  const result = await managementRequest(() => {
    return client.resetHostKey({
      params: { connectionId: id },
      body: { expectedGeneration },
    });
  });
  if (result.status !== 200)
    handleManagementError(result, "Cannot reset SSH host key");
  return metadata(hostMetadataSchema, result.body);
}

export async function listSshCredentials() {
  const client = initClient(sshCredentialsContract, await getClientConfig());
  const result = await managementRequest(() => {
    return client.list();
  });
  if (result.status !== 200)
    handleManagementError(result, "Cannot list SSH credentials");
  return metadata(
    z.object({ credentials: z.array(credentialMetadataSchema) }),
    result.body,
  );
}

export async function showSshCredential(id: string) {
  const inventory = await listSshCredentials();
  const credential = inventory.credentials.find((item) => {
    return item.id.toLowerCase() === id.toLowerCase();
  });
  if (!credential)
    throw new Error(
      "SSH credential not found. Refresh okou ssh credential list.",
    );
  return credential;
}

export async function createSshCredential(
  body: CreateSshCredentialRequest & { id: string },
) {
  const client = initClient(sshCredentialsContract, await getClientConfig());
  const result = await managementRequest(() => {
    return client.create({ body });
  });
  if (result.status === 204) return { id: body.id, outcome: "created" };
  if (result.status !== 201)
    handleManagementError(result, "Cannot create SSH credential");
  return metadata(credentialMetadataSchema, result.body);
}

export async function updateSshCredential(
  id: string,
  body: UpdateSshCredentialRequest,
) {
  const client = initClient(sshCredentialsContract, await getClientConfig());
  const result = await managementRequest(() => {
    return client.update({ params: { credentialId: id }, body });
  });
  if (result.status !== 200)
    handleManagementError(result, "Cannot update SSH credential");
  return metadata(credentialMetadataSchema, result.body);
}

export async function deleteSshCredential(
  id: string,
  expectedRevision: number,
) {
  const client = initClient(sshCredentialsContract, await getClientConfig());
  const result = await managementRequest(() => {
    return client.delete({
      params: { credentialId: id },
      body: { expectedRevision },
    });
  });
  if (result.status !== 204)
    handleManagementError(result, "Cannot delete SSH credential");
  return { id, outcome: "deleted" };
}
