import {
  fetchHostedDomainJson,
  HostedDomainDependencyError,
} from "./hosted-domain-request";
import { joinAll } from "../utils";
import { array, number, object, string, type infer as zInfer } from "zod";
import type { hostedDomainCheckSchema } from "@okouai/api-contracts/contracts/hosted-site-domains";

type Check = zInfer<typeof hostedDomainCheckSchema>;
const answerSchema = object({
  Status: number(),
  Answer: array(
    object({ name: string(), type: number(), data: string() }),
  ).optional(),
});
async function query(name: string, type: string, signal: AbortSignal) {
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.search = new URLSearchParams({ name, type }).toString();
  const result = answerSchema.parse(
    await fetchHostedDomainJson(
      "dns",
      url,
      { headers: { Accept: "application/dns-json" } },
      signal,
    ),
  );
  if (result.Status !== 0 && result.Status !== 3) {
    throw new HostedDomainDependencyError("dns");
  }
  return result;
}
const normalize = (hostname: string) => {
  return hostname.toLowerCase().replace(/\.$/u, "");
};
export async function verifyDomainOwnership(
  hostname: string,
  challenge: string,
  signal: AbortSignal,
): Promise<Check> {
  const name = `_okou-challenge.${hostname}`;
  const result = await query(name, "TXT", signal);
  const values = (result.Answer ?? [])
    .filter((answer) => {
      return answer.type === 16 && normalize(answer.name) === name;
    })
    .map((answer) => {
      return Array.from(
        answer.data.matchAll(/"((?:[^"\\]|\\.)*)"/gu),
        (match) => {
          return JSON.parse(`"${match[1]}"`) as string;
        },
      ).join("");
    });
  return values.includes(`okou-verification=${challenge}`)
    ? { status: "passed", message: "Ownership verified" }
    : {
        status: "failed",
        message:
          result.Status === 3
            ? "The TXT record was not found (NXDOMAIN). Add it and click Verify again."
            : "The TXT record does not match. Update it and click Verify again.",
      };
}
export async function verifyDomainRouting(
  hostname: string,
  target: string,
  apexAddresses: readonly string[],
  signal: AbortSignal,
): Promise<Check> {
  const seen = new Set<string>();
  let current = hostname;
  for (let depth = 0; depth < 8; depth++) {
    if (seen.has(current)) {
      return {
        status: "failed",
        message: "Your DNS records contain a CNAME loop",
      };
    }
    seen.add(current);
    const result = await query(current, "CNAME", signal);
    const cnames = result.Answer?.filter((answer) => {
      return answer.type === 5 && normalize(answer.name) === current;
    });
    if (cnames && cnames.length > 1) {
      return {
        status: "failed",
        message: "Remove conflicting CNAME records and click Verify again.",
      };
    }
    const cname = cnames?.[0];
    if (!cname) {
      break;
    }
    current = normalize(cname.data);
    if (current === normalize(target)) {
      return { status: "passed", message: "DNS connection verified" };
    }
  }
  if (apexAddresses.length) {
    const [a, aaaa] = await joinAll([
      query(hostname, "A", signal),
      query(hostname, "AAAA", signal),
    ]);
    const addresses = [...(a.Answer ?? []), ...(aaaa.Answer ?? [])]
      .filter((answer) => {
        return answer.type === 1 || answer.type === 28;
      })
      .map((answer) => {
        return answer.data.toLowerCase();
      });
    if (
      addresses.length &&
      addresses.every((address) => {
        return apexAddresses.includes(address);
      })
    ) {
      return { status: "passed", message: "DNS connection verified" };
    }
  }
  return {
    status: "pending",
    message:
      "Point your domain to the provided CNAME target. For a root domain, use supported flattening or the allocated Apex Proxying addresses.",
  };
}
