import { createHostRequestAccessCommand } from "../host-request-access";
export function createSshRequestAccessCommand() {
  return createHostRequestAccessCommand("ssh");
}
