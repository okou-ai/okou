import { randomUUID } from "node:crypto";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import {
  runnerVncContract,
  type RunnerVncResolveRequest,
} from "@okouai/api-contracts/contracts/runner-vnc";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { mockEnv } from "../../../../lib/env";
import { chatRemoteAccessRoutes } from "../../chat-remote-access";
import { runnerVncRoutes } from "../../runner-vnc";
import { vncConnectionsRoutes } from "../../vnc-connections";
import { createRouteMocks } from "./route-test";
import { useSecretKmsProbe } from "./secret-kms-probe";

export const vncSessionHeaders = Object.freeze({
  authorization: "Bearer clerk-session",
});
const runnerSecret = "c".repeat(64);
export const vncRunnerHeaders = Object.freeze({
  authorization: `Bearer vm0_official_${runnerSecret}`,
});
export const vncSecurity = Object.freeze({
  type: "x509_vnc" as const,
  trust: Object.freeze({ mode: "system" as const }),
});
const vncTransportTypes = ["direct", "ssh"] as const;
export const vncX509VncProfiles = Object.freeze(
  vncTransportTypes.map((transportType) => {
    return {
      authMethod: "vnc_password" as const,
      securityType: "x509_vnc" as const,
      transportType,
    };
  }),
);
export const vncProfiles = Object.freeze([
  ...vncX509VncProfiles,
  ...vncTransportTypes.map((transportType) => {
    return {
      authMethod: "username_password" as const,
      securityType: "x509_plain" as const,
      transportType,
    };
  }),
]);
export const vncPassword = " secret ";
type Owner = { readonly orgId: string; readonly userId: string };

export function initializeVncRuntimeTest() {
  mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
  useSecretKmsProbe();
}

export function vncConnectionBody(id: string = randomUUID()) {
  return {
    id,
    displayName: "VNC desktop",
    host: "vnc.example.com",
    credential: {
      create: {
        name: "VNC password",
        authentication: {
          method: "vnc_password" as const,
          password: vncPassword,
        },
      },
    },
    security: vncSecurity,
  };
}

export function createVncRuntimeApi(context: TestContext) {
  const mocks = createRouteMocks(context);
  const runner = () => {
    return setupApp({ context, routes: runnerVncRoutes })(runnerVncContract);
  };
  const connections = () => {
    return setupApp({ context, routes: vncConnectionsRoutes })(
      vncConnectionsContract,
    );
  };
  const credentials = () => {
    return setupApp({ context, routes: vncConnectionsRoutes })(
      vncCredentialsContract,
    );
  };
  function authenticate(owner: Owner) {
    mocks.clerk.session(owner.userId, owner.orgId);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          id: `member_${owner.orgId}_${owner.userId}`,
          publicUserData: { userId: owner.userId },
          organization: { id: owner.orgId },
          role: "org:admin",
        },
      ],
      totalCount: 1,
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            id: `member_${owner.orgId}_${owner.userId}`,
            publicUserData: { userId: owner.userId },
            organization: { id: owner.orgId },
            role: "org:admin",
          },
        ],
        totalCount: 1,
      },
    );
  }
  async function setDefault(
    owner: Owner,
    protocol: "ssh" | "vnc",
    connectionId: string,
    enabled: boolean,
  ) {
    authenticate(owner);
    const remote = setupApp({ context, routes: chatRemoteAccessRoutes })(
      chatRemoteAccessContract,
    );
    await accept(
      remote.updateHostDefault({
        headers: vncSessionHeaders,
        params: { protocol, connectionId },
        body: { enabled },
      }),
      [200],
    );
  }
  async function enableDefault(
    owner: Owner,
    protocol: "ssh" | "vnc",
    connectionId: string,
  ) {
    await setDefault(owner, protocol, connectionId, true);
  }
  async function resolve(
    f: Pick<VncRuntimeFixture, "runId" | "connectionId" | "runnerIdentity">,
    override: Partial<RunnerVncResolveRequest> = {},
  ) {
    return (
      await accept(
        runner().resolve({
          headers: vncRunnerHeaders,
          params: { runId: f.runId },
          body: {
            connectionId: f.connectionId,
            runnerIdentity: f.runnerIdentity,
            supportedProfiles: [...vncProfiles],
            ...override,
          },
        }),
        [200],
      )
    ).body;
  }
  async function resolved(f: Parameters<typeof resolve>[0]) {
    const result = await resolve(f);
    if (result.outcome !== "resolved_transport") {
      throw new Error(`VNC fixture did not resolve: ${result.outcome}`);
    }
    return result;
  }
  return {
    runner,
    connections,
    credentials,
    authenticate,
    setDefault,
    enableDefault,
    resolve,
    resolved,
  };
}

export interface VncRuntimeFixture extends Owner {
  readonly runId: string;
  readonly threadId?: string;
  readonly agentId: string;
  readonly sandboxToken: string;
  readonly runnerIdentity: {
    runnerId: ReturnType<typeof randomUUID>;
    heartbeatGeneration: number;
  };
  readonly connectionId: string;
  readonly credentialId: string;
}
