import {
  cloudflareAccessContract,
  type DeleteCloudflareAccessRequest,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { createStore } from "ccstate";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { cloudflareAccessRoutes } from "../../cloudflare-access";
import { sshConnectionsRoutes } from "../../ssh-connections";
import { joinAll, settleIncludingAbort } from "../../../utils";
import { seedOrgMembership$ } from "./org-membership";
import { createRouteMocks } from "./route-test";

export interface CloudflareAccessLifecycleOwner {
  readonly userId: string;
  readonly orgId: string;
  readonly membershipId: string;
}

export async function cleanupCloudflareAccessLifecycle(
  context: TestContext,
  owners: readonly CloudflareAccessLifecycleOwner[],
): Promise<void> {
  const store = createStore();
  const mocks = createRouteMocks(context);
  // Finished callbacks follow central mock reset. Restore only surviving actors;
  // their cleanup admin role also releases shared configs after creator erasure.
  for (const owner of owners) {
    await store.set(
      seedOrgMembership$,
      { ...owner, role: "admin" },
      context.signal,
    );
  }

  const headers = { authorization: "Bearer clerk-session" };
  const query = { view: "scoped" as const };
  const hosts = setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
  const credentials = setupApp({ context, routes: sshConnectionsRoutes })(
    sshCredentialsContract,
  );
  const configs = setupApp({ context, routes: cloudflareAccessRoutes })(
    cloudflareAccessContract,
  );
  const errors: unknown[] = [];
  async function forEachOwner(cleanup: () => Promise<void>) {
    for (const owner of owners) {
      const result = await settleIncludingAbort(async () => {
        // One mutable Clerk session: finish this actor's work before switching.
        mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
        await cleanup();
      });
      if (!result.ok) {
        errors.push(result.error);
      }
    }
  }

  // Inventories recover committed setup even when its response assertion failed.
  await forEachOwner(async () => {
    const listed = await accept(hosts.list({ headers }), [200]);
    await joinAll(
      listed.body.connections.map(({ id, generation }) => {
        return accept(
          hosts.delete({
            headers,
            params: { connectionId: id },
            body: { expectedGeneration: generation },
          }),
          [204],
        );
      }),
    );
  });
  await forEachOwner(async () => {
    const listed = await accept(credentials.list({ headers }), [200]);
    await joinAll(
      listed.body.credentials.map(({ id, revision }) => {
        return accept(
          credentials.delete({
            headers,
            params: { credentialId: id },
            body: { expectedRevision: revision },
          }),
          [204],
        );
      }),
    );
  });
  await forEachOwner(async () => {
    const listed = await accept(configs.list({ headers, query }), [200]);
    await joinAll(
      listed.body.configs.map(async ({ id, scope, revision }) => {
        let body: DeleteCloudflareAccessRequest = {
          expectedRevision: revision,
        };
        if (scope === "organization") {
          const preview = await accept(
            configs.impactPreview({
              headers,
              params: { configId: id },
              query: { operation: "delete" },
            }),
            [200],
          );
          body = {
            expectedRevision: preview.body.expectedRevision,
            impactSnapshot: preview.body.impactSnapshot,
          };
        }
        await accept(
          configs.delete({
            headers,
            params: { configId: id },
            query,
            body,
          }),
          [204],
        );
      }),
    );
  });
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Cloudflare Access lifecycle cleanup failed",
    );
  }
}
