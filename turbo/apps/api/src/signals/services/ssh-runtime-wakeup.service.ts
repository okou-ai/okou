import { command } from "ccstate";

import { publishSshClientInvalidation } from "./ssh-client-invalidation.service";
import {
  publishRemoteRunnerInvalidation$,
  type RemoteInvalidationScope,
} from "./remote-runtime-wakeup.service";

export const publishSshRunnerInvalidation$ = command(
  async ({ set }, scope: RemoteInvalidationScope): Promise<void> => {
    await set(publishRemoteRunnerInvalidation$, scope, "ssh");
  },
);

export const publishSshRuntimeInvalidation$ = command(
  async ({ set }, scope: RemoteInvalidationScope) => {
    await publishSshClientInvalidation(scope);
    await set(publishSshRunnerInvalidation$, scope);
  },
);
