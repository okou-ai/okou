import {
  cloudflareAccessContract,
  type ScopedCloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import {
  sshCredentialsContract,
  type SshCredentialResponse,
} from "@okouai/api-contracts/contracts/ssh-credentials";
import {
  tailscaleContract,
  type TailscaleConfig,
} from "@okouai/api-contracts/contracts/tailscale";
import {
  vncConnectionsContract,
  type VncConnectionResponse,
} from "@okouai/api-contracts/contracts/vnc-connections";
import {
  vncCredentialsContract,
  type VncCredentialResponse,
} from "@okouai/api-contracts/contracts/vnc-credentials";

import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export const REMOTE_TIMESTAMP = "2026-10-27T00:00:00.000Z";

export function remoteId(prefix: string, index: number): string {
  return `${prefix}0000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

export function sshHost(
  index: number,
  displayName: string,
  overrides: Partial<SshConnectionResponse> = {},
): SshConnectionResponse {
  return {
    id: remoteId("b", index),
    displayName,
    host: `ssh-${index}.example.com`,
    port: 22,
    username: "deploy",
    credentialId: remoteId("d", 1),
    credentialName: "Deployment login",
    generation: 1,
    learnedHostKey: null,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    ...overrides,
  };
}

export function vncHost(
  index: number,
  displayName: string,
  overrides: Partial<VncConnectionResponse> = {},
): VncConnectionResponse {
  return {
    id: remoteId("e", index),
    displayName,
    host: `vnc-${index}.example.com`,
    port: 5900,
    credentialId: remoteId("f", 1),
    credentialName: "Desktop login",
    security: { type: "x509_vnc", trust: { mode: "system" } },
    generation: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    ...overrides,
  };
}

/**
 * The owner's remote access inventory as the API reports it. Tests change the
 * arrays between reads to model server-side updates.
 */
export interface RemoteInventory {
  ssh: SshConnectionResponse[];
  vnc: VncConnectionResponse[];
  sshCredentials: SshCredentialResponse[];
  vncCredentials: VncCredentialResponse[];
  tailscale: TailscaleConfig[];
  cloudflare: ScopedCloudflareAccessConfig[];
}

export function mockRemoteInventory(
  context: TestContext,
  initial: Partial<RemoteInventory> = {},
): RemoteInventory {
  const inventory: RemoteInventory = {
    ssh: [],
    vnc: [],
    sshCredentials: [],
    vncCredentials: [],
    tailscale: [],
    cloudflare: [],
    ...initial,
  };
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [...inventory.ssh] });
  });
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: inventory.ssh.length });
  });
  context.mocks.api(sshConnectionsContract.observations, ({ respond }) => {
    return respond(200, { observations: [] });
  });
  context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [...inventory.vnc] });
  });
  context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: inventory.vnc.length });
  });
  context.mocks.api(vncConnectionsContract.observations, ({ respond }) => {
    return respond(200, { observations: [] });
  });
  context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [...inventory.sshCredentials] });
  });
  context.mocks.api(vncCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [...inventory.vncCredentials] });
  });
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [...inventory.tailscale] });
  });
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [...inventory.cloudflare] });
  });
  return inventory;
}
