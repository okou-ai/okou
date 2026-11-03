import { HttpAgent, HttpsAgent } from "agentkeepalive";

import { currentRequestRuntime } from "./request-runtime";
import { singleton } from "./singleton";

export interface S3RequestHandler {
  readonly httpAgent: HttpAgent;
  readonly httpsAgent: HttpsAgent;
}

interface ClientOwner {
  readonly peek: () => { destroy(): void } | undefined;
  readonly reset: () => void;
}

// Bound all S3 clients together, including virtual-hosted bucket origins.
// HTTP and HTTPS each retain at most 64 sockets, leaving room for the runtime
// and other providers under Vercel's shared 1,024-descriptor limit.
const agentOptions = Object.freeze({
  keepAlive: true,
  maxSockets: 32,
  maxTotalSockets: 64,
  maxFreeSockets: 8,
  freeSocketTimeout: 30_000,
  // Only idle pooled sockets expire here; the SDK and each operation continue
  // to own active-request timeouts and cancellation.
  timeout: 0,
});

class NodeS3Transport {
  readonly clients = new Set<ClientOwner>();
  readonly handler: S3RequestHandler = {
    httpAgent: new HttpAgent({ ...agentOptions }),
    httpsAgent: new HttpsAgent({ ...agentOptions }),
  };

  close(): void {
    for (const owner of this.clients) {
      const client = owner.peek();
      owner.reset();
      client?.destroy();
    }
    // The SDK does not destroy externally owned agents.
    this.handler.httpAgent.destroy();
    this.handler.httpsAgent.destroy();
  }
}

const nodeS3Transport = singleton(() => {
  return new NodeS3Transport();
});

/** Keep fixed Node configuration out of request-scoped ccstate Stores. */
export function createLazyS3Client<T extends { destroy(): void }>(
  create: (handler: S3RequestHandler | undefined) => T,
): () => T {
  const nodeClient = singleton((): T => {
    const transport = nodeS3Transport();
    const client = create(transport.handler);
    transport.clients.add(nodeClient);
    return client;
  });
  return () => {
    // Workers cannot reuse request-owned I/O across invocations. Their ccstate
    // Store retains the existing request-local SDK client and transport.
    return currentRequestRuntime() ? create(undefined) : nodeClient();
  };
}

/** Release the transport owner after its requests and background work settle. */
export function closeS3Clients(): void {
  const current = nodeS3Transport.peek();
  nodeS3Transport.reset();
  current?.close();
}
