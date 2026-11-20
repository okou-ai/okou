import { getOkouToken, getOkouAgentId } from "./okou-env";
import { decodeSandboxTokenPayload } from "./api/sandbox-token";

/** Standalone commands use My Okou. Runs keep the mode in their signed token. */
export function isPersonalExecution(): boolean {
  const token = getOkouToken();
  if (!getOkouAgentId() && !token?.startsWith("vm0_sandbox_")) return true;
  return decodeSandboxTokenPayload(token)?.singleAgent === true;
}
