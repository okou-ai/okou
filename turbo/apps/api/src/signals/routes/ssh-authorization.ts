import { sshAuthorizationContract } from "@okouai/api-contracts/contracts/ssh-authorization";
import { createHostAuthorizationRoutes } from "./host-authorization";
export const sshAuthorizationRoutes = createHostAuthorizationRoutes(
  "ssh",
  sshAuthorizationContract,
);
