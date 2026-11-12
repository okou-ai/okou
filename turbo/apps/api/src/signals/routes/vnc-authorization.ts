import { vncAuthorizationContract } from "@okouai/api-contracts/contracts/vnc-authorization";
import { createHostAuthorizationRoutes } from "./host-authorization";
export const vncAuthorizationRoutes = createHostAuthorizationRoutes(
  "vnc",
  vncAuthorizationContract,
);
