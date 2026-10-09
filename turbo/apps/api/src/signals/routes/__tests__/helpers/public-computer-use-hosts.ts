import { randomUUID } from "node:crypto";
import type { TestContext } from "../../../../__tests__/test-context";
import { settleIncludingAbort } from "../../../utils";
import type { ApiTestUser } from "./api-bdd";
import { createComputerUseBddApi } from "./api-bdd-computer-use";

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
      hostToken?: string;
      hostId?: string;
      stopped?: boolean;
    }
  >();
  return {
    async start(
      actor: ApiTestUser,
      run: RunOperation,
      options: HostOptions = {},
    ) {
      const installationId = options.installationId ?? randomUUID();
      const key = `${actor.orgId}:${actor.userId}:${installationId}`;
      const previous = hosts.get(key);
      const host: {
        readonly actor: ApiTestUser;
        readonly options: HostOptions & {
          readonly installationId: string;
          readonly hostName: string;
        };
        hostToken?: string;
        hostId?: string;
        stopped?: boolean;
      } = {
        actor,
        options: {
          ...options,
          installationId,
          hostName:
            options.hostName ??
            previous?.options.hostName ??
            `Owned Desktop ${randomUUID()}`,
        },
        hostToken: undefined,
        hostId: previous?.hostId,
      };
      // A reconnect may rotate the credential before its response is received.
      // Do not retain an earlier token as proof of the new connection.
      return await run(async () => {
        hosts.set(key, host);
        const started = await api.startComputerUseHost(actor, host.options);
        host.hostToken = started.hostToken;
        host.hostId = started.hostId;
        return started;
      });
    },
    async stop(
      connection: { readonly hostId: string; readonly hostToken: string },
      run: RunOperation,
    ) {
      const host = [...hosts.values()].find((item) => {
        return (
          item.hostId === connection.hostId &&
          item.hostToken === connection.hostToken
        );
      });
      if (!host) {
        throw new Error("Expected the current owned Computer Use connection");
      }
      return await run(async () => {
        // If this response is lost, cleanup must recover the connection through
        // public discovery; it cannot assume the old generation is still valid.
        host.hostToken = undefined;
        const stopped = await api.stopComputerUseHost(connection.hostToken);
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
          let token = host.hostToken;
          if (!token) {
            const listed = await api.listComputerUseHosts(host.actor);
            const matching = listed.hosts.filter((item) => {
              return host.hostId
                ? item.id === host.hostId
                : item.displayName === host.options.hostName;
            });
            if (matching.length === 0) {
              return;
            }
            if (matching.length !== 1) {
              throw new Error("Expected exactly one owned Computer Use host");
            }
            token = (await api.startComputerUseHost(host.actor, host.options))
              .hostToken;
          }
          await api.stopComputerUseHost(token);
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
