import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import {
  vncConnectionsContract,
  type VncConnectionResponse,
} from "@okouai/api-contracts/contracts/vnc-connections";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export const timestamp = "2026-10-27T00:00:00.000Z";
export const names = Object.freeze([
  "dev-11",
  "dev-2",
  "android",
  "dev-1",
  "DEV-1",
]);
export const orderedNames = Object.freeze([
  "android",
  "DEV-1",
  "dev-1",
  "dev-2",
  "dev-11",
]);

export function resourceId(prefix: string, index: number): string {
  return `${prefix}0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

// Reverse IDs relative to input order so equivalent names exercise the tie-break.
export const sshHosts: SshConnectionResponse[] = names.map(
  (displayName, index) => {
    return {
      id: resourceId("b", names.length - index - 1),
      displayName,
      host: `ssh-${index + 1}.example.com`,
      port: 22,
      username: "deploy",
      credentialId: resourceId("d", 0),
      credentialName: "SSH login",
      generation: 1,
      learnedHostKey: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  },
);

export const vncHosts: VncConnectionResponse[] = names.map(
  (displayName, index) => {
    return {
      id: resourceId("e", names.length - index - 1),
      displayName: `desktop-${displayName}`,
      host: `vnc-${index + 1}.example.com`,
      port: 5900,
      credentialId: resourceId("f", 0),
      credentialName: "VNC login",
      security: { type: "x509_vnc", trust: { mode: "system" } },
      generation: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  },
);

export function mockHostInventories(context: TestContext): void {
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: sshHosts.length });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: sshHosts });
  });
  context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: vncHosts.length });
  });
  context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: vncHosts });
  });
  context.mocks.api(sshConnectionsContract.observations, ({ respond }) => {
    return respond(200, { observations: [] });
  });
  context.mocks.api(vncConnectionsContract.observations, ({ respond }) => {
    return respond(200, { observations: [] });
  });
  context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [] });
  });
  context.mocks.api(vncCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [] });
  });
}

export function mockRemoteChoices(context: TestContext): void {
  const ssh = sshHosts.map((host, index) => {
    return {
      connectionId: host.id,
      displayName: host.displayName,
      defaultEnabled: index === 0,
    };
  });
  const vnc = vncHosts.map((host) => {
    return {
      connectionId: host.id,
      displayName: host.displayName,
      defaultEnabled: false,
    };
  });
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      computerUseHosts: names.map((displayName, index) => {
        return {
          id: resourceId("a", names.length - index - 1),
          hostName: `desktop-${index}.local`,
          displayName,
          status: "online" as const,
          lastSeenAt: timestamp,
        };
      }),
      cloudBrowserAvailable: true,
      cloudBrowserEnabledByDefault: true,
      sshHosts: ssh,
      vncHosts: vnc,
    });
  });
  context.mocks.api(
    chatRemoteAccessContract.listHostDefaults,
    ({ respond }) => {
      return respond(200, { ssh, vnc });
    },
  );
  context.mocks.api(
    chatRemoteAccessContract.listThreadAccess,
    ({ respond }) => {
      return respond(200, {
        ssh: ssh.map((host, index) => {
          return {
            ...host,
            overrideEnabled: index === 1 ? true : null,
            enabled: host.defaultEnabled || index === 1,
            source: index === 1 ? ("override" as const) : ("default" as const),
          };
        }),
        vnc: vnc.map((host) => {
          return {
            ...host,
            overrideEnabled: null,
            enabled: false,
            source: "default" as const,
          };
        }),
      });
    },
  );
}
