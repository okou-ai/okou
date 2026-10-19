import type { CloudflareAccessConfig } from "@okouai/api-contracts/contracts/cloudflare-access";

type References = Pick<CloudflareAccessConfig, "sshHosts" | "vncHosts">;

export function privateNetworkHostCount(config: References) {
  return config.sshHosts.length + config.vncHosts.length;
}
