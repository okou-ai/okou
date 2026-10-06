import { createMemberModelBootstrap } from "./model-bootstrap.service";

export function createProviderContext(orgId: string, userId: string) {
  return { memberModels$: createMemberModelBootstrap(orgId, userId) };
}
