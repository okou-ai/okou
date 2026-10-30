import { computed } from "ccstate";
import { buildInfoContract } from "@okouai/api-contracts/client/build-info";

import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";

interface BackendBuildInfo {
  readonly backendCommitSha: string | null;
  readonly backendVersion: string | null;
}

export const backendBuildInfo$ = computed(
  async (get): Promise<BackendBuildInfo> => {
    const createClient = get(apiClient$);
    const client = createClient(buildInfoContract);
    const result = await accept(client.get(), [200]);

    return {
      backendCommitSha: result.body.commitSha,
      backendVersion: result.body.version ?? null,
    };
  },
);
