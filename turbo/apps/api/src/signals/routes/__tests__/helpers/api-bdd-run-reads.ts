import { mockClerkUsers } from "./clerk-users";
import type { z } from "zod";
import {
  logsByIdContract,
  logsListContract,
} from "@okouai/api-contracts/contracts/logs";
import { queuePositionContract } from "@okouai/api-contracts/contracts/queue-position";
import {
  runAgentEventsContract,
  runNetworkLogsContract,
} from "@okouai/api-contracts/contracts/run-routes";

import { createApp } from "../../../../app-factory";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import {
  createDirectRunFixture,
  listAgentRunsFixture,
  type DirectRunFixtureRequest,
} from "../../../../test-fixtures/agent-runs";
import type { ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";
import { logsRoutes } from "../../logs";
import { queuePositionRoutes } from "../../queue-position";
import { runDetailRoutes } from "../../run-detail";

const TEST_APP_ROUTES = Object.freeze([
  ...logsRoutes,
  ...queuePositionRoutes,
  ...runDetailRoutes,
]);

type AuthHeaders = {
  readonly authorization?: string;
};
type DirectRunRequest = DirectRunFixtureRequest;
interface RunsListQuery {
  readonly status?: string;
  readonly agent?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}
type AgentEventsQuery = z.input<
  (typeof runAgentEventsContract.getAgentEvents)["query"]
>;
type NetworkLogsQuery = z.input<
  (typeof runNetworkLogsContract.getNetworkLogs)["query"]
>;
type LogsListQuery = z.input<(typeof logsListContract.list)["query"]>;

interface ClerkUserProfile {
  readonly id: string;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
  }[];
  readonly primaryEmailAddressId: string;
  readonly firstName: string;
  readonly lastName: string;
}

function clerkUserProfile(actor: ApiTestUser): ClerkUserProfile {
  const emailId = `email_${actor.userId}`;
  return {
    id: actor.userId,
    emailAddresses: [{ id: emailId, emailAddress: actor.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "RunReads",
  };
}

function authenticate(
  context: TestContext,
  nextActor: ApiTestUser | null,
): AuthHeaders {
  if (!nextActor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }

  createRouteMocks(context).clerk.session(
    nextActor.userId,
    nextActor.orgId,
    nextActor.orgRole,
  );
  mockClerkUsers(context, [clerkUserProfile(nextActor)]);
  return { authorization: "Bearer clerk-session" };
}

export function createRunReadsApi(context: TestContext) {
  return {
    async requestCreateDirectRun<
      TStatus extends 201 | 400 | 401 | 403 | 404 | 429,
    >(
      actor: ApiTestUser | null,
      body: DirectRunRequest,
      statuses: readonly TStatus[],
    ) {
      const response = !actor?.orgId
        ? {
            status: 401 as const,
            body: {
              error: {
                message: "Not authenticated",
                code: "UNAUTHORIZED" as const,
              },
            },
          }
        : await createDirectRunFixture({
            userId: actor.userId,
            orgId: actor.orgId,
            body,
            signal: context.signal,
          });
      return await accept(Promise.resolve(response), statuses);
    },

    async requestListAgentRuns<TStatus extends 200 | 400>(
      actor: ApiTestUser,
      query: RunsListQuery,
      statuses: readonly TStatus[],
    ) {
      if (!actor.orgId) {
        throw new Error("Agent run list service requires an organization");
      }
      const result = await listAgentRunsFixture({
        userId: actor.userId,
        orgId: actor.orgId,
        status: query.status,
        agent: query.agent,
        since: query.since,
        until: query.until,
        limit: query.limit,
      });
      const response =
        result.kind === "bad-request"
          ? {
              status: 400 as const,
              body: {
                error: {
                  message: result.message,
                  code: "BAD_REQUEST" as const,
                },
              },
            }
          : { status: 200 as const, body: result.body };
      return await accept(Promise.resolve(response), statuses);
    },

    async requestAgentRunAgentEvents<
      TStatus extends 200 | 400 | 401 | 403 | 404,
    >(
      actor: ApiTestUser | null,
      runId: string,
      query: AgentEventsQuery,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context, routes: runDetailRoutes })(
          runAgentEventsContract,
        ).getAgentEvents({
          headers: authenticate(context, actor),
          params: { id: runId },
          query,
        }),
        statuses,
      );
    },

    async requestAgentRunNetworkLogs<
      TStatus extends 200 | 400 | 401 | 403 | 404,
    >(
      actor: ApiTestUser | null,
      runId: string,
      query: NetworkLogsQuery,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context, routes: runDetailRoutes })(
          runNetworkLogsContract,
        ).getNetworkLogs({
          headers: authenticate(context, actor),
          params: { id: runId },
          query,
        }),
        statuses,
      );
    },

    async requestQueuePosition<TStatus extends 200 | 400 | 401 | 404>(
      actor: ApiTestUser | null,
      runId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context, routes: queuePositionRoutes })(
          queuePositionContract,
        ).getPosition({
          headers: authenticate(context, actor),
          query: { runId },
        }),
        statuses,
      );
    },

    async requestListLogs<TStatus extends 200 | 400 | 401>(
      actor: ApiTestUser | null,
      query: LogsListQuery,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context, routes: logsRoutes })(logsListContract).list({
          headers: authenticate(context, actor),
          query,
        }),
        statuses,
      );
    },

    /** Exercises the HTTP boundary with a query shape from a removed client. */
    async requestListLogsWithRemovedAutomationSource(
      actor: ApiTestUser | null,
    ) {
      return await accept(
        setupApp({ context, routes: logsRoutes })(logsListContract).list({
          headers: authenticate(context, actor),
          query: { triggerSource: "automation" } as unknown as LogsListQuery,
        }),
        [400],
      );
    },

    /** Lists logs with a raw bearer credential (Okou run token). */
    async requestListLogsAs<TStatus extends 200 | 401 | 403>(
      authorization: string,
      query: LogsListQuery,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context, routes: logsRoutes })(logsListContract).list({
          headers: { authorization },
          query,
        }),
        statuses,
      );
    },

    async requestReadLogById<TStatus extends 200 | 401 | 403 | 404>(
      actor: ApiTestUser | null,
      runId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context, routes: logsRoutes })(logsByIdContract).getById({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        statuses,
      );
    },

    /** Reads one log detail with a raw bearer credential (Okou run token). */
    async requestReadLogByIdAs<TStatus extends 200 | 401 | 403 | 404>(
      authorization: string,
      runId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context, routes: logsRoutes })(logsByIdContract).getById({
          headers: { authorization },
          params: { id: runId },
        }),
        statuses,
      );
    },

    // Raw GET for 400s the typed contracts cannot express (queue-position
    // without runId and network queries rejected by zod before the handler).
    async rawApiRequest(
      actor: ApiTestUser | null,
      path: string,
    ): Promise<{ readonly status: number; readonly body: unknown }> {
      const { authorization } = authenticate(context, actor);
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request(path, {
        method: "GET",
        headers: authorization === undefined ? {} : { authorization },
      });
      const body: unknown = await response.json();
      return { status: response.status, body };
    },
  };
}
