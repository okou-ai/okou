import { randomUUID } from "node:crypto";
import type { TestContext } from "../../../../__tests__/test-context";
import { settleIncludingAbort } from "../../../utils";
import type { ApiTestUser } from "./api-bdd";
import {
  createComputerUseBddApi,
  type ComputerUseTestConnection,
} from "./api-bdd-computer-use";

type HostOptions = NonNullable<
  Parameters<
    ReturnType<typeof createComputerUseBddApi>["startComputerUseHost"]
  >[1]
>;
type RunOperation = <T>(operation: () => Promise<T>) => Promise<T>;

/** Normal Desktop start/reconnect/stop, subordinate to the caller's request owner. */
export function createPublicComputerUseHosts(context: TestContext) {
  const api = createComputerUseBddApi(context);
  const hosts = new Map<
    string,
    {
      readonly actor: ApiTestUser;
      readonly options: HostOptions & {
        readonly installationId: string;
        readonly hostName: string;
      };
      connection?: ComputerUseTestConnection;
      hostId?: string;
      stopped?: boolean;
      pendingStarts: number;
      ambiguousGeneration: boolean;
      readonly issuedConnections: Set<ComputerUseTestConnection>;
      readonly requestedNames: Set<string>;
    }
  >();
  return {
    async start(
      actor: ApiTestUser,
      run: RunOperation,
      options: HostOptions = {},
      request?: (options: HostOptions) => Promise<{
        readonly hostId: string;
        readonly connection: ComputerUseTestConnection;
      }>,
    ) {
      const installationId = options.installationId ?? randomUUID();
      const key = `${actor.orgId}:${actor.userId}:${installationId}`;
      const hostName =
        options.hostName ??
        hosts.get(key)?.options.hostName ??
        `Owned Desktop ${randomUUID()}`;
      const requested = { ...options, installationId, hostName };
      // A reconnect may advance the generation before its response is received.
      // Do not retain an earlier generation as proof of the new connection.
      return await run(async () => {
        let host = hosts.get(key);
        if (!host) {
          host = {
            actor,
            options: requested,
            pendingStarts: 0,
            ambiguousGeneration: false,
            issuedConnections: new Set(),
            requestedNames: new Set(),
          };
          hosts.set(key, host);
        }
        host.ambiguousGeneration =
          host.pendingStarts > 0 || host.ambiguousGeneration;
        host.pendingStarts += 1;
        host.requestedNames.add(hostName);
        host.connection = undefined;
        host.stopped = false;
        const result = await settleIncludingAbort(async () => {
          return request
            ? await request(requested)
            : await api.startComputerUseHost(actor, requested);
        });
        host.pendingStarts -= 1;
        if (!result.ok) {
          throw result.error;
        }
        const started = await result.value;
        host.issuedConnections.add(started.connection);
        // Concurrent starts can commit and respond in different orders. Neither
        // response alone identifies the final generation for cleanup.
        if (!host.ambiguousGeneration) {
          host.connection = started.connection;
        }
        host.hostId = started.hostId;
        return started;
      });
    },
    async requestStop(
      connection: ComputerUseTestConnection | null,
      statuses: readonly (200 | 401 | 409)[],
      run: RunOperation,
    ) {
      return await run(async () => {
        const host = [...hosts.values()].find((item) => {
          return connection !== null && item.issuedConnections.has(connection);
        });
        if (host) {
          host.connection = undefined;
        }
        const response = await api.requestStopComputerUseHost(
          connection,
          statuses,
        );
        if (host && response.status === 200) {
          host.stopped = true;
        }
        return response;
      });
    },
    async stop(
      connection: {
        readonly hostId: string;
        readonly connection: ComputerUseTestConnection;
      },
      run: RunOperation,
    ) {
      const host = [...hosts.values()].find((item) => {
        return (
          item.hostId === connection.hostId &&
          item.issuedConnections.has(connection.connection)
        );
      });
      if (!host) {
        throw new Error("Expected the current owned Computer Use connection");
      }
      return await run(async () => {
        // If this response is lost, cleanup must recover the connection through
        // public discovery; it cannot assume the old generation is still valid.
        host.connection = undefined;
        const stopped = await api.stopComputerUseHost(connection.connection);
        host.stopped = true;
        return stopped;
      });
    },
    async cleanup() {
      const errors: unknown[] = [];
      for (const host of hosts.values()) {
        if (host.stopped) {
          continue;
        }
        const stopped = await settleIncludingAbort(async () => {
          let connection = host.connection;
          if (!connection) {
            const listed = await api.listComputerUseHosts(host.actor);
            const matching = listed.hosts.filter((item) => {
              return host.hostId
                ? item.id === host.hostId
                : host.requestedNames.has(item.displayName);
            });
            if (matching.length === 0) {
              return;
            }
            if (matching.length !== 1) {
              throw new Error("Expected exactly one owned Computer Use host");
            }
            connection = (
              await api.startComputerUseHost(host.actor, host.options)
            ).connection;
          }
          await api.stopComputerUseHost(connection);
        });
        if (!stopped.ok) {
          errors.push(stopped.error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Computer Use hosts did not stop");
      }
    },
  };
}
