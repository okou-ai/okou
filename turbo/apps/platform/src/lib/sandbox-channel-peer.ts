import {
  SandboxChannelPeer,
  type SandboxChannelPeerOptions,
} from "@okouai/core/sandbox-channel-peer";
import type { RunWssTransportOptions } from "@okouai/core/run-wss-transport";
import type { ApiClientFactory } from "../signals/api-client.ts";
import { createBrowserRunWssTransport } from "./run-wss-transport.ts";

/** Inert authenticated factory; the visible consumer supplies connect's owner. */
export function createBrowserSandboxChannelPeer(
  runId: string,
  createClient: ApiClientFactory,
  options: SandboxChannelPeerOptions &
    Pick<RunWssTransportOptions, "createSocket">,
): SandboxChannelPeer {
  return new SandboxChannelPeer((transportOptions) => {
    return createBrowserRunWssTransport(runId, createClient, {
      ...transportOptions,
      createSocket: options.createSocket,
    });
  }, options);
}
