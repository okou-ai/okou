import { command } from "ccstate";
import { publishRemoteRunnerInvalidation$ } from "./remote-runtime-wakeup.service";
import { publishSshClientInvalidation } from "./ssh-client-invalidation.service";
import type { NetworkReference } from "./network-config-model";

/** Committed references survive detachment; do not rediscover through deleted rows. */
export const publishNetworkHostInvalidation$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly hosts: readonly NetworkReference[];
    },
  ) => {
    const groups = new Map<
      string,
      { userId: string; protocol: "ssh" | "vnc"; ids: string[] }
    >();
    for (const host of args.hosts) {
      const key = JSON.stringify([host.userId, host.protocol]);
      let group = groups.get(key);
      if (!group) {
        group = { userId: host.userId, protocol: host.protocol, ids: [] };
        groups.set(key, group);
      }
      group.ids.push(host.id);
    }
    const recipients = [...groups.values()];
    for (let offset = 0; offset < recipients.length; offset += 16) {
      const publications = [];
      for (const group of recipients.slice(offset, offset + 16)) {
        publications.push(
          (async () => {
            if (group.protocol === "ssh") {
              await publishSshClientInvalidation({
                orgId: args.orgId,
                userId: group.userId,
              });
            }
            await set(
              publishRemoteRunnerInvalidation$,
              {
                orgId: args.orgId,
                userId: group.userId,
                connectionIds: group.ids,
              },
              group.protocol,
            );
          })(),
        );
      }
      await Promise.all(publications);
    }
  },
);
