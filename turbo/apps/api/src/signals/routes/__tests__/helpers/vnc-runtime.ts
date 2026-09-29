import { randomUUID } from "node:crypto";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import {
  runnerVncContract,
  type RunnerVncResolveRequest,
} from "@okouai/api-contracts/contracts/runner-vnc";
import {
  testSshConnectionStateContract,
  type TestSshConnectionStateActionBody,
} from "@okouai/api-contracts/contracts/test-ssh-connection-state";
import { testVncAuthorityStateContract } from "@okouai/api-contracts/contracts/test-vnc-authority-state";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { mockEnv } from "../../../../lib/env";
import { chatRemoteAccessRoutes } from "../../chat-remote-access";
import { runnerVncRoutes } from "../../runner-vnc";
import { testSshConnectionStateRoutes } from "../../test-ssh-connection-state";
import { testVncAuthorityStateRoutes } from "../../test-vnc-authority-state";
import { vncConnectionsRoutes } from "../../vnc-connections";
import { updateFeatureSwitchesForUser } from "./feature-switches";
import { createRouteMocks } from "./route-test";
import { useSecretKmsProbe } from "./secret-kms-probe";
import { requireVncCredentialId } from "./vnc-response";

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
type RuntimeBody = Extract<
  TestSshConnectionStateActionBody,
  { action: "create-runtime" }
>;

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
  const state = () => {
    return setupApp({ context, routes: testVncAuthorityStateRoutes })(
      testVncAuthorityStateContract,
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
  async function runtime(owner: Owner, overrides: Partial<RuntimeBody> = {}) {
    const runnerIdentity = {
      runnerId: randomUUID(),
      heartbeatGeneration: 5_000_000_000,
    };
    // Winning process attribution and historical Run shapes have no owner API.
    const result = await accept(
      setupApp({ context, routes: testSshConnectionStateRoutes })(
        testSshConnectionStateContract,
      ).action({
        body: {
          action: "create-runtime",
          orgId: owner.orgId,
          userId: owner.userId,
          ...runnerIdentity,
          triggerSource: "web",
          status: "running",
          chat: true,
          ...overrides,
        },
      }),
      [200],
    );
    if (
      !result.body.runId ||
      !result.body.agentId ||
      !result.body.sandboxToken
    ) {
      throw new Error("Missing VNC runtime fixture identity");
    }
    return {
      runId: result.body.runId,
      threadId: result.body.threadId,
      agentId: result.body.agentId,
      sandboxToken: result.body.sandboxToken,
      runnerIdentity,
    };
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
  async function fixture(
    options: {
      readonly defaultEnabled?: boolean;
      readonly runtime?: Partial<RuntimeBody>;
    } = {},
  ) {
    const owner = {
      orgId: `org_vnc_runtime_${randomUUID()}`,
      userId: `user_vnc_runtime_${randomUUID()}`,
    };
    await updateFeatureSwitchesForUser(context, owner, {
      [FeatureSwitchKey.VncAccess]: true,
    });
    authenticate(owner);
    const connection = await accept(
      connections().create({
        headers: vncSessionHeaders,
        body: vncConnectionBody(),
      }),
      [201],
    );
    if (options.defaultEnabled !== false) {
      await enableDefault(owner, "vnc", connection.body.id);
    }
    const running = await runtime(owner, options.runtime);
    const result = {
      ...owner,
      ...running,
      connectionId: connection.body.id,
      credentialId: requireVncCredentialId(connection.body),
    };
    return result;
  }
  async function resolve(
    f: Pick<
      Awaited<ReturnType<typeof fixture>>,
      "runId" | "connectionId" | "runnerIdentity"
    >,
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
    state,
    authenticate,
    runtime,
    setDefault,
    enableDefault,
    fixture,
    resolve,
    resolved,
  };
}

export type VncRuntimeApi = ReturnType<typeof createVncRuntimeApi>;
export type VncRuntimeFixture = Awaited<ReturnType<VncRuntimeApi["fixture"]>>;
