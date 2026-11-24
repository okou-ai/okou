import { HOSTED_DOMAIN_PROBE_HEADER } from "@okouai/api-contracts/contracts/hosted-site-domains";
import { settleIncludingAbort } from "../utils";

type DomainDependency = "dns" | "provider" | "ingress";
export class HostedDomainDependencyError extends Error {
  constructor(
    readonly dependency: DomainDependency,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super("Custom domain dependency is unavailable", options);
  }
}
/** Only fixed operator-controlled DNS, provider and ingress origins use this transport. */
export async function fetchHostedDomainJson(
  dependency: DomainDependency,
  url: string | URL,
  init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  const result = await settleIncludingAbort(async () => {
    const response = await fetch(url, {
      ...init,
      signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    if (
      new Headers(init.headers).has(HOSTED_DOMAIN_PROBE_HEADER) &&
      response.headers.get(HOSTED_DOMAIN_PROBE_HEADER) !== "1"
    ) {
      throw new HostedDomainDependencyError("ingress", 503);
    }
    if (!response.ok) {
      throw new HostedDomainDependencyError(dependency, response.status);
    }
    return response.json() as Promise<unknown>;
  });
  if (result.ok) {
    return result.value;
  }
  if (result.error instanceof HostedDomainDependencyError) {
    throw result.error;
  }
  throw new HostedDomainDependencyError(dependency, undefined, {
    cause: result.error,
  });
}
