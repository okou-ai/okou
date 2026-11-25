import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { parse } from "tldts";
import { object, string, ZodError, type infer as zInfer } from "zod";
import type { hostedDomainSetupSchema } from "@okouai/api-contracts/contracts/hosted-site-domains";
import { HostedDomainDependencyError } from "./hosted-domain-request";
import { env } from "../../lib/env";
import { settleIncludingAbort } from "../utils";
import {
  queryHostedDomainDns,
  hostedDomainTxtValues,
} from "./hosted-domain-dns";

class DomainConnectUnavailable extends Error {}

interface Provider {
  readonly name: string;
  readonly discovery: string;
  readonly origins: readonly string[];
  readonly console: string;
}
// DNS is untrusted. Only these public provider origins may receive discovery
// requests; redirects are never followed and no credentials are sent.
const providers: readonly Provider[] = [
  {
    name: "Cloudflare",
    discovery: "api.cloudflare.com/client/v4/dns/domainconnect",
    origins: ["https://api.cloudflare.com", "https://dash.cloudflare.com"],
    console: "https://dash.cloudflare.com/",
  },
  {
    name: "Vercel",
    discovery: "domainconnect.vercel.com",
    origins: ["https://domainconnect.vercel.com", "https://vercel.com"],
    console: "https://vercel.com/domains",
  },
  {
    name: "GoDaddy",
    discovery: "_domainconnect.gd.domaincontrol.com",
    origins: [
      "https://api.domainconnect.godaddy.com",
      "https://domainconnect.godaddy.com",
      "https://_domainconnect.gd.domaincontrol.com",
    ],
    console: "https://dcc.godaddy.com/",
  },
  {
    name: "IONOS",
    discovery: "_domainconnect.1and1.com",
    origins: [
      "https://api.domainconnect.1and1.com",
      "https://domainconnect.ionos.com",
      "https://_domainconnect.1and1.com",
    ],
    console: "https://my.ionos.com/domains",
  },
];
const settingsSchema = object({
  providerId: string(),
  providerName: string(),
  urlAPI: string(),
  urlSyncUX: string().optional(),
});
const manual = (
  provider: Provider | null,
  unavailable = false,
): zInfer<typeof hostedDomainSetupSchema> => {
  return {
    providerName: provider?.name ?? null,
    controlPanelUrl: provider?.console ?? null,
    automaticUrl: null,
    status: unavailable ? "unavailable" : "manual",
  };
};
function providerUrl(value: string, provider: Provider) {
  const url = new URL(value);
  if (
    !provider.origins.includes(url.origin) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new DomainConnectUnavailable("Untrusted Domain Connect endpoint");
  }
  return url.toString().replace(/\/$/u, "");
}
async function request(url: string, signal: AbortSignal) {
  const response = await fetch(url, {
    signal,
    credentials: "omit",
    redirect: "manual",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (response.status === 404) {
    return null;
  }
  if (response.status !== 200) {
    throw new DomainConnectUnavailable("Domain Connect provider unavailable");
  }
  return response;
}
async function discover(hostname: string, signal: AbortSignal) {
  const root = parse(hostname, { allowPrivateDomains: true }).domain;
  if (!root) {
    return null;
  }
  let zone = hostname;
  for (;;) {
    const result = await queryHostedDomainDns(
      `_domainconnect.${zone}`,
      "TXT",
      signal,
    );
    const values = (result.Answer ?? [])
      .filter((answer) => {
        return (
          (answer.type === 16 || answer.type === 5) &&
          answer.name.toLowerCase().replace(/\.$/u, "") ===
            `_domainconnect.${zone}`
        );
      })
      .map((answer) => {
        return answer.type === 16
          ? hostedDomainTxtValues(answer.data).replace(/\/$/u, "")
          : answer.data.toLowerCase().replace(/\.$/u, "");
      });
    if (new Set(values).size > 1) {
      return null;
    }
    const provider = providers.find((item) => {
      return values.includes(item.discovery);
    });
    if (provider) {
      return { provider, zone };
    }
    // An advertised but unsupported provider must never be replaced by a
    // different provider found higher in the DNS tree.
    if (values.length || zone === root) {
      return null;
    }
    zone = zone.slice(zone.indexOf(".") + 1);
  }
}
async function identifyNameservers(hostname: string, signal: AbortSignal) {
  const root = parse(hostname, { allowPrivateDomains: true }).domain;
  if (!root) {
    return null;
  }
  let zone = hostname;
  let names: string[] = [];
  for (;;) {
    const result = await queryHostedDomainDns(zone, "NS", signal);
    names = (result.Answer ?? [])
      .filter((answer) => {
        return (
          answer.type === 2 &&
          answer.name.toLowerCase().replace(/\.$/u, "") === zone
        );
      })
      .map((answer) => {
        return answer.data.toLowerCase();
      });
    if (names.length || zone === root) {
      break;
    }
    zone = zone.slice(zone.indexOf(".") + 1);
  }
  const matches = [
    ["cloudflare.com.", "Cloudflare", "https://dash.cloudflare.com/"],
    ["vercel-dns.com.", "Vercel", "https://vercel.com/domains"],
    ["domaincontrol.com.", "GoDaddy", "https://dcc.godaddy.com/"],
    [
      "registrar-servers.com.",
      "Namecheap",
      "https://ap.www.namecheap.com/domains/list/",
    ],
    [
      "digitalocean.com.",
      "DigitalOcean",
      "https://cloud.digitalocean.com/networking/domains",
    ],
    ["dnsimple.com.", "DNSimple", "https://dnsimple.com/"],
    ["alidns.com.", "Alibaba Cloud", "https://dns.console.aliyun.com/"],
    ["dnspod.net.", "DNSPod", "https://console.dnspod.cn/"],
  ];
  const match = matches.find(([suffix]) => {
    return (
      names.length > 0 &&
      names.every((n) => {
        return n.endsWith(`.${suffix}`);
      })
    );
  });
  return match
    ? {
        providerName: match[1]!,
        controlPanelUrl: match[2]!,
        automaticUrl: null,
        status: "manual" as const,
      }
    : null;
}

async function publishedSigningKey(signal: AbortSignal) {
  const privateKeyBase64 = env("HOSTED_SITE_DOMAIN_CONNECT_PRIVATE_KEY_BASE64");
  const keyHost = env("HOSTED_SITE_DOMAIN_CONNECT_KEY_HOST");
  if (!privateKeyBase64 || !keyHost) {
    return null;
  }
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    type: "pkcs8",
    format: "der",
  });
  if (privateKey.asymmetricKeyType !== "rsa") {
    throw new Error("Domain Connect requires an RSA signing key");
  }
  const expectedKey = createPublicKey(privateKey)
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const publicRecords = await queryHostedDomainDns(
    `${keyHost}._domainconnect.okou.ai`,
    "TXT",
    signal,
  );
  const fragments = (publicRecords.Answer ?? [])
    .filter((a) => {
      return (
        a.type === 16 &&
        a.name.toLowerCase().replace(/\.$/u, "") ===
          `${keyHost}._domainconnect.okou.ai`
      );
    })
    .map((a) => {
      const fields = Object.fromEntries(
        hostedDomainTxtValues(a.data)
          .split(",")
          .map((field) => {
            const at = field.indexOf("=");
            return [field.slice(0, at).trim(), field.slice(at + 1).trim()];
          }),
      );
      return fields;
    });
  if (
    !fragments.length ||
    fragments.some((f) => {
      return (
        !/^[1-9][0-9]*$/u.test(f.p ?? "") ||
        (f.a !== undefined && f.a !== "RS256")
      );
    }) ||
    new Set(
      fragments.map((f) => {
        return f.p;
      }),
    ).size !== fragments.length
  ) {
    return null;
  }
  fragments.sort((a, b) => {
    return Number(a.p) - Number(b.p);
  });
  if (
    fragments.some((fragment, index) => {
      return Number(fragment.p) !== index + 1;
    })
  ) {
    return null;
  }
  const published = fragments
    .map((f) => {
      return f.d;
    })
    .join("");
  if (published !== expectedKey) {
    return null;
  }
  return { privateKey, keyHost };
}

export async function discoverHostedDomainSetup(
  hostname: string,
  records: readonly {
    readonly type: string;
    readonly name: string;
    readonly value: string;
  }[],
  ownerSignal: AbortSignal,
): Promise<zInfer<typeof hostedDomainSetupSchema>> {
  const signal = AbortSignal.any([ownerSignal, AbortSignal.timeout(5000)]);
  let known: Provider | null = null;
  const attempt = await settleIncludingAbort(async () => {
    const discovered = await discover(hostname, signal);
    if (!discovered) {
      return (await identifyNameservers(hostname, signal)) ?? manual(null);
    }
    const { provider, zone } = discovered;
    known = provider;
    const response = await request(
      `https://${provider.discovery}/v2/${encodeURIComponent(zone)}/settings`,
      signal,
    );
    if (!response) {
      return manual(provider);
    }
    const settings = settingsSchema.parse(await response.json());
    const api = providerUrl(settings.urlAPI, provider);
    if (!settings.urlSyncUX) {
      return manual(provider);
    }
    const ux = providerUrl(settings.urlSyncUX, provider);
    // Query Okou's exact template, never the public example service template.
    const support = await request(
      `${api}/v2/domainTemplates/providers/okou.ai/services/hosted-site`,
      signal,
    );
    if (!support) {
      return manual(provider);
    }
    const target = env("HOSTED_SITE_CUSTOM_DOMAIN_TARGET");
    const cname = records.find((record) => {
      return record.type === "CNAME" && record.name === hostname;
    });
    const ownership = records.find((record) => {
      return (
        record.type === "TXT" && record.name === `_okou-challenge.${hostname}`
      );
    });
    if (!target || !cname || cname.value !== target || !ownership) {
      return manual(provider);
    }
    const signing = await publishedSigningKey(signal);
    if (!signing) {
      return manual(provider);
    }
    const { privateKey, keyHost } = signing;
    const host = hostname === zone ? "" : hostname.slice(0, -(zone.length + 1));
    const query = new URLSearchParams({
      domain: zone,
      verification: ownership.value.slice("okou-verification=".length),
      target,
    });
    if (host) {
      query.set("host", host);
    }
    // The redirect is navigation only. Cloudflare ignores state and Vercel
    // returns it: neither callback is authority to verify or select a domain.
    const app = new URL(env("APP_URL"));
    if (app.origin === "https://app.okou.ai") {
      query.set("redirect_uri", new URL("/artifacts", app).toString());
    }
    query.sort();
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(query.toString()),
      privateKey,
    ).toString("base64");
    query.set("key", keyHost);
    query.set("sig", signature); // Cloudflare requires sig last; both exclude sig and key when verifying.
    return {
      providerName: provider.name,
      controlPanelUrl: provider.console,
      automaticUrl: `${ux}/v2/domainTemplates/providers/okou.ai/services/hosted-site/apply?${query}`,
      status: "supported" as const,
    };
  });
  ownerSignal.throwIfAborted();
  if (attempt.ok) {
    return attempt.value;
  }
  if (
    attempt.error instanceof DomainConnectUnavailable ||
    attempt.error instanceof HostedDomainDependencyError ||
    attempt.error instanceof ZodError ||
    attempt.error instanceof SyntaxError ||
    attempt.error instanceof TypeError ||
    attempt.error instanceof DOMException
  ) {
    return manual(known, true);
  }
  throw attempt.error;
}
