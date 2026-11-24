import { joinAll } from "../utils";
import {
  fetchHostedDomainJson,
  HostedDomainDependencyError,
} from "./hosted-domain-request";
import { array, boolean, object, string, unknown } from "zod";
import { env } from "../../lib/env";

const hostnameSchema = object({
  id: string(),
  hostname: string(),
  status: string(),
  ownership_verification: object({ name: string(), value: string() }).nullish(),
  ssl: object({
    status: string(),
    validation_errors: array(object({ message: string() })).optional(),
    validation_records: array(
      object({ txt_name: string().optional(), txt_value: string().optional() }),
    ).optional(),
  }),
});
const envelopeSchema = object({
  success: boolean(),
  result: unknown(),
  errors: array(object({ message: string() })).optional(),
});

function configuration() {
  const token = env("HOSTED_SITE_CUSTOM_DOMAIN_API_TOKEN");
  const zone = env("HOSTED_SITE_CUSTOM_DOMAIN_ZONE_ID");
  if (!token || !zone) {
    throw new HostedDomainDependencyError("provider", 503);
  }
  return { token, zone };
}
async function zoneRequest(
  path: string,
  init: RequestInit,
  signal: AbortSignal,
) {
  const { token, zone } = configuration();
  const envelope = envelopeSchema.parse(
    await fetchHostedDomainJson(
      path === "custom_hostnames/fallback_origin" || path === "workers/routes"
        ? "ingress"
        : "provider",
      `https://api.cloudflare.com/client/v4/zones/${zone}/${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
      signal,
    ),
  );
  if (!envelope.success) {
    throw new HostedDomainDependencyError("provider");
  }
  return envelope.result;
}
function providerRequest(path: string, init: RequestInit, signal: AbortSignal) {
  return zoneRequest(`custom_hostnames${path}`, init, signal);
}
export async function hostedDomainIngressConfigured(signal: AbortSignal) {
  const [fallback, routes] = await joinAll([
    zoneRequest("custom_hostnames/fallback_origin", {}, signal),
    zoneRequest("workers/routes", {}, signal),
  ]);
  const origin = object({ origin: string(), status: string() }).parse(fallback);
  const workers = array(
    object({ pattern: string(), script: string().nullish() }),
  ).parse(routes);
  return (
    origin.status === "active" &&
    workers.some((route) => {
      return (
        route.pattern === "*/*" &&
        route.script === env("HOSTED_SITE_CUSTOM_DOMAIN_WORKER")
      );
    })
  );
}
export async function findHostedDomain(hostname: string, signal: AbortSignal) {
  return array(hostnameSchema).parse(
    await providerRequest(
      `?hostname=${encodeURIComponent(hostname)}`,
      {},
      signal,
    ),
  );
}
export async function readHostedDomain(id: string, signal: AbortSignal) {
  return hostnameSchema.parse(
    await providerRequest(`/${encodeURIComponent(id)}`, {}, signal),
  );
}
export async function createHostedDomain(
  hostname: string,
  signal: AbortSignal,
) {
  return hostnameSchema.parse(
    await providerRequest(
      "",
      {
        method: "POST",
        body: JSON.stringify({
          hostname,
          ssl: {
            method: "txt",
            type: "dv",
            settings: { min_tls_version: "1.2" },
          },
        }),
      },
      signal,
    ),
  );
}
export async function deleteHostedDomain(id: string, signal: AbortSignal) {
  await providerRequest(
    `/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    signal,
  );
}
export function providerDomainRecords(
  hostname: ReturnType<typeof hostnameSchema.parse>,
) {
  const records =
    hostname.ssl.validation_records?.flatMap((item) => {
      return item.txt_name && item.txt_value
        ? [{ type: "TXT" as const, name: item.txt_name, value: item.txt_value }]
        : [];
    }) ?? [];
  if (hostname.ownership_verification) {
    records.push({
      type: "TXT",
      name: hostname.ownership_verification.name,
      value: hostname.ownership_verification.value,
    });
  }
  return records;
}
