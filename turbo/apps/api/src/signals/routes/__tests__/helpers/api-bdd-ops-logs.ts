import { mockClerkUsers } from "./clerk-users";
import { userExportContract } from "@okouai/api-contracts/contracts/user-export";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { createDeferredPromise } from "../../../utils";
import type { ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";
import { userExportRoutes } from "../../user-export";

type AuthHeaders = { readonly authorization?: string };

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
    lastName: "OpsLogs",
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

export function createOpsLogsApi(context: TestContext) {
  return {
    async requestGetUserExport<TStatus extends 200 | 401 | 403 | 500>(
      actor: ApiTestUser | null,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context, routes: userExportRoutes })(userExportContract).get(
          {
            headers: authenticate(context, actor),
          },
        ),
        statuses,
      );
    },

    async requestPostUserExport<TStatus extends 202 | 401 | 403 | 429 | 500>(
      actor: ApiTestUser | null,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context, routes: userExportRoutes })(
          userExportContract,
        ).post({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    /**
     * Holds the next `s3.send` call (the export zip PutObject) open until
     * `resolve()` is called, keeping the detached export job observable in
     * its pending/running window. Deterministic only while the export actor
     * owns no composes/threads/artifacts, so the zip put is the flow's sole
     * `s3.send` call.
     */
    deferS3PutOnce(): { readonly resolve: () => void } {
      const pending = createDeferredPromise<unknown>(context.signal);
      const resolvePut = (): void => {
        if (!pending.settled()) {
          pending.resolve({});
        }
      };
      context.mocks.s3.send.mockReturnValueOnce(pending.promise);
      return { resolve: resolvePut };
    },
  };
}
