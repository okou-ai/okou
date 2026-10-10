import { randomUUID } from "node:crypto";
import { onTestFinished } from "vitest";
import {
  desktopCompatibility,
  type TestContext,
} from "../../../../__tests__/test-context";
import { now, withMockNowForTest } from "../../../../lib/time";
import { settleIncludingAbort } from "../../../utils";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createChatFilesBddApi } from "./api-bdd-chat-files";
import { createRunsApi } from "./api-bdd-runs";
import { createRunReadsApi } from "./api-bdd-run-reads";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import {
  createComputerUseBddApi,
  type ComputerUseTestConnection,
} from "./api-bdd-computer-use";
import { createFixtureOperationOwner } from "./fixture-operation-owner";
import { createPublicComputerUseHosts } from "./public-computer-use-hosts";
import { captureConnectorExternalState } from "./public-connector-actor";
import { captureSessionStorageMocks } from "./prepared-session-history";
import { deletePublicWorkspace } from "./public-workspace-cleanup";
import { mockClaudeCodeTokenEndpoint } from "./api-bdd-auth-device";
import { createAuthOrgAgentsBddApi } from "./api-bdd-auth-org";

/** Own this case's normal Desktop requests and the real Runs issuing its tokens. */
export function createPublicComputerUseScenario(
  context: TestContext,
  options: {
    readonly optionalEnvironmentNames?: readonly string[];
    readonly retainProviderState?: () => () => void;
  } = {},
) {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const chat = createChatFilesBddApi(context);
  const hosts = createPublicComputerUseHosts(context);
  const actors = new Map<string, ApiTestUser>();
  const claims = new Map<
    string,
    { actor: ApiTestUser; sandboxToken: string }
  >();
  const activeClaims = new Map<string, string>();
  const resources: (() => Promise<void>)[] = [];
  const personalTokens = new Map<string, ApiTestUser>();
  const prepared = new Map<
    string,
    Promise<{ agentId: string; runnerGroup: string }>
  >();
  function captureExternalState() {
    const base = captureConnectorExternalState(
      context,
      options.optionalEnvironmentNames,
    );
    const providers = options.retainProviderState?.();
    const minimumDesktopVersion = desktopCompatibility.minimumSupportedVersion;
    return () => {
      desktopCompatibility.minimumSupportedVersion = minimumDesktopVersion;
      base();
      providers?.();
    };
  }
  let accepted = captureExternalState();
  let previous: (() => void) | undefined;
  let restoreSetupWebhook: (() => void) | undefined;
  let acceptedTime = now();

  function remember(actor: ApiTestUser) {
    if (actor.orgId) {
      actors.set(`${actor.orgId}:${actor.userId}`, actor);
    }
    return actor;
  }
  async function cancelClaim(
    actor: ApiTestUser,
    runId: string,
    perform: <T>(operation: () => Promise<T>) => Promise<T> = (operation) => {
      return operation();
    },
  ) {
    const cancelled = await settleIncludingAbort(() => {
      return perform(() => {
        return runs.requestCancelRun(actor, runId, [200]);
      });
    });
    const errors: unknown[] = cancelled.ok ? [] : [cancelled.error];
    const claim = claims.get(runId);
    if (claim) {
      const acknowledged = await settleIncludingAbort(() => {
        return perform(() => {
          return createWebhookCallbackApi(context).requestAgentComplete(
            { runId, exitCode: 1, error: "Run cancelled" },
            { authorization: `Bearer ${claim.sandboxToken}` },
            [200],
          );
        });
      });
      if (acknowledged.ok) {
        claims.delete(runId);
      } else {
        errors.push(acknowledged.error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Run cancellation/ACK failed");
    }
  }

  onTestFinished(() => {
    return previous?.();
  });
  const owner = createFixtureOperationOwner(
    async () => {
      await withMockNowForTest(acceptedTime, async () => {
        const errors: unknown[] = [];
        async function settle(operation: () => Promise<unknown>) {
          const result = await settleIncludingAbort(operation);
          if (!result.ok) {
            errors.push(result.error);
          }
        }
        await settle(flushWaitUntilForTest);
        const handledRuns = new Set<string>();
        for (const actor of actors.values()) {
          await settle(async () => {
            const reads = createRunReadsApi(context);
            let page = await reads.requestListLogs(
              actor,
              { limit: 100 },
              [200],
            );
            const all = [...page.body.data];
            while (page.body.pagination.hasMore) {
              const cursor = page.body.pagination.nextCursor;
              if (!cursor) {
                throw new Error("Expected the public Run-list cursor");
              }
              page = await reads.requestListLogs(
                actor,
                { limit: 100, cursor },
                [200],
              );
              all.push(...page.body.data);
            }
            for (const item of all) {
              handledRuns.add(item.id);
              await settle(async () => {
                if (["queued", "pending", "running"].includes(item.status)) {
                  await cancelClaim(actor, item.id);
                } else if (claims.has(item.id) && item.status === "cancelled") {
                  const claim = claims.get(item.id);
                  if (!claim) {
                    throw new Error("Expected the actual Runner claim");
                  }
                  await createWebhookCallbackApi(context).requestAgentComplete(
                    { runId: item.id, exitCode: 1, error: "Run cancelled" },
                    { authorization: `Bearer ${claim.sandboxToken}` },
                    [200],
                  );
                }
              });
            }
          });
        }
        for (const [runId, claim] of claims) {
          if (!handledRuns.has(runId)) {
            await settle(() => {
              return cancelClaim(claim.actor, runId);
            });
          }
        }
        await settle(flushWaitUntilForTest);
        await settle(() => {
          return hosts.cleanup();
        });
        for (const cleanup of resources) {
          await settle(cleanup);
        }
        const workspaces = new Map<string, ApiTestUser>();
        for (const actor of actors.values()) {
          if (actor.orgId) {
            workspaces.set(actor.orgId, actor);
          }
        }
        for (const actor of workspaces.values()) {
          await settle(() => {
            return deletePublicWorkspace(context, actor);
          });
        }
        for (const userId of new Set(
          [...actors.values()].map((actor) => {
            return actor.userId;
          }),
        )) {
          await settle(async () => {
            const webhooks = createWebhookCallbackApi(context);
            webhooks.configureClerkWebhookSecret();
            webhooks.verifyNextClerkWebhook({
              type: "user.deleted",
              data: { id: userId },
            });
            await webhooks.requestClerkWebhook("{}", {}, [200]);
          });
        }
        await settle(flushWaitUntilForTest);
        if (errors.length) {
          throw new AggregateError(errors, "Computer Use cleanup failed");
        }
      });
    },
    {
      continueAcceptedOperations: true,
      beforeDrain: () => {
        previous ??= captureExternalState();
        accepted();
        restoreSetupWebhook?.();
      },
    },
  );
  function run<T>(operation: () => Promise<T>): Promise<T> {
    return owner.run(() => {
      acceptedTime = now();
      return withMockNowForTest(acceptedTime, () => {
        const pending = settleIncludingAbort(operation);
        accepted = captureExternalState();
        return pending.then((result) => {
          if (!result.ok) {
            throw result.error;
          }
          return result.value;
        });
      });
    });
  }
  const api = createComputerUseBddApi(context, run);
  const computerUse = {
    ...api,
    async requestStartComputerUseHost(
      ...args: Parameters<typeof api.requestStartComputerUseHost>
    ) {
      const [auth, statuses, options, signal] = args;
      const actor =
        auth && ("bearer" in auth ? personalTokens.get(auth.bearer) : auth);
      if (!actor?.orgId || (auth && "bearer" in auth)) {
        return await api.requestStartComputerUseHost(...args);
      }
      let response:
        Awaited<ReturnType<typeof api.requestStartComputerUseHost>> | undefined;
      await hosts.start(remember(actor), run, options, async (registered) => {
        const result = await api.requestStartComputerUseHost(
          auth,
          statuses,
          registered,
          signal,
        );
        response = result;
        if (result.status !== 200) {
          throw new Error("Expected an owned host start");
        }
        return result.body;
      });
      if (!response) {
        throw new Error("Expected the host start response");
      }
      return response;
    },
    requestStopComputerUseHost(
      connection: ComputerUseTestConnection | null,
      statuses: readonly (200 | 401 | 409)[],
    ) {
      return hosts.requestStop(connection, statuses, run);
    },
    async stopComputerUseHost(connection: ComputerUseTestConnection) {
      const response = await hosts.requestStop(connection, [200], run);
      return response.body;
    },
    startComputerUseHost(
      actor: ApiTestUser,
      options?: Parameters<typeof api.startComputerUseHost>[1],
    ) {
      return hosts.start(remember(actor), run, options);
    },
  };
  function prepareActor(actor: ApiTestUser) {
    const key = `${actor.orgId}:${actor.userId}`;
    let existing = prepared.get(key);
    if (!existing) {
      existing = run(async () => {
        bdd.acceptAgentStorageWrites();
        runs.acceptStorageDownloads();
        runs.acceptTelemetryIngest();
        const runnerGroup = runs.configureRunnerGroup();
        await run(() => {
          return runs.grantProEntitlement(actor, {
            run,
            onExternalStateReady: (restore) => {
              restoreSetupWebhook = restore;
            },
          });
        });
        restoreSetupWebhook = undefined;
        mockClaudeCodeTokenEndpoint();
        await run(() => {
          return runs.createPersonalModelProvider(actor, {
            type: "claude-code-oauth-token",
            secret: "bdd-personal-claude-token",
          });
        });
        await run(() => {
          return runs.updateUserModelPreference(actor, "claude-fable-5-1");
        });
        const agent = await run(() => {
          return bdd.createAgent(actor, {
            displayName: "Computer Use public authorization",
            visibility: "private",
          });
        });
        return { agentId: agent.agentId, runnerGroup };
      });
      prepared.set(key, existing);
    }
    return existing;
  }
  return {
    run,
    computerUse,
    beforeWorkspaceCleanup(cleanup: () => Promise<void>) {
      resources.push(cleanup);
    },
    prepareActor,
    cancelRun(actor: ApiTestUser, runId: string) {
      return run(() => {
        return cancelClaim(actor, runId, run);
      });
    },
    claimExisting(actor: ApiTestUser, runId: string) {
      return run(async () => {
        remember(actor);
        const actual = await runs.claimRunnerJob(runId);
        claims.set(runId, { actor, sandboxToken: actual.sandboxToken });
        activeClaims.set(`${actor.orgId}:${actor.userId}`, runId);
        return actual;
      });
    },
    async createCliToken(actor: ApiTestUser) {
      return await run(async () => {
        const result = await createAuthOrgAgentsBddApi(context).createCliToken(
          remember(actor),
          run,
        );
        personalTokens.set(result.token, actor);
        return result;
      });
    },
    user(...args: Parameters<typeof bdd.user>) {
      return remember(bdd.user(...args));
    },
    async claim(actor: ApiTestUser, hostId?: string) {
      return await run(async () => {
        remember(actor);
        // Actor/Runner setup uses its ordinary object-store boundary; restore the
        // caller's screenshot adapter, including its existing bytes, afterwards.
        const restoreStorage = captureSessionStorageMocks(context);
        const result = await settleIncludingAbort(async () => {
          bdd.acceptAgentStorageWrites();
          runs.acceptStorageDownloads();
          const setup = await prepareActor(actor);
          const key = `${actor.orgId}:${actor.userId}`;
          const previousRun = activeClaims.get(key);
          if (previousRun) {
            await run(() => {
              return cancelClaim(actor, previousRun, run);
            });
            activeClaims.delete(key);
          }
          const clientEventId = randomUUID();
          const sent = await run(() => {
            return chat.requestSendEvent(
              actor,
              {
                agentId: setup.agentId,
                prompt: "Use the selected Desktop",
                clientEventId,
                computerUseHostId: hostId ?? null,
              },
              [201],
            );
          });
          if (sent.status !== 201) {
            throw new Error("Expected an accepted chat send");
          }
          await run(flushWaitUntilForTest);
          const { events } = await run(() => {
            return chat.listThreadEvents(actor, sent.body.threadId);
          });
          const launched = events.find((event) => {
            return (
              event.eventType === "input.prompt" &&
              event.revokesEventId === clientEventId &&
              event.runId !== undefined
            );
          });
          if (!launched?.runId) {
            throw new Error("Expected the public launched Run");
          }
          const runId = launched.runId;
          await run(() => {
            return runs.heartbeatRunner(setup.runnerGroup);
          });
          const claim = await run(async () => {
            const actual = await runs.claimRunnerJob(runId);
            claims.set(runId, { actor, sandboxToken: actual.sandboxToken });
            activeClaims.set(key, runId);
            return actual;
          });
          const token = claim.platformEnvironment.OKOU_TOKEN;
          if (!token) {
            throw new Error("Expected the actual claimed Okou token");
          }
          return {
            token,
            runId,
            threadId: sent.body.threadId,
            sandboxToken: claim.sandboxToken,
          };
        });
        restoreStorage();
        accepted = captureExternalState();
        if (!result.ok) {
          throw result.error;
        }
        return result.value;
      });
    },
  };
}
