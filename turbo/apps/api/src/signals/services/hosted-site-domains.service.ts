import {
  HOSTED_DOMAIN_PROBE_HEADER,
  type HostedDomainVerification,
  type hostedDomainSettingsSchema,
} from "@okouai/api-contracts/contracts/hosted-site-domains";
import { ZodError, type infer as zInfer } from "zod";
import {
  fetchHostedDomainJson,
  HostedDomainDependencyError,
} from "../external/hosted-domain-request";
import { settle, settleIncludingAbort } from "../utils";
import { availableForSite$ } from "./hosted-site-url-availability.service";
import { randomBytes, randomUUID } from "node:crypto";
import { command } from "ccstate";
import { and, eq, exists, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { orgTierSchema } from "@okouai/api-contracts/contracts/orgs";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import {
  hostedSiteDomains,
  hostedSiteDomainSettings,
} from "@okouai/db/schema/hosted-site-domain";
import { hostedSites, hostedDeployments } from "@okouai/db/runtime/hosted-site";
import { hostedSiteBrowserSessions } from "@okouai/db/schema/hosted-site-browser-session";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { hostedLinkOrigin } from "../../lib/link-layout";
import {
  normalizeHostedSiteHostname,
  hostedSiteApexHostname,
} from "../../lib/hosted-site-hostname";
import { isUniqueViolation } from "../../lib/pg-errors";
import { db$, writeDb$ } from "../external/db";
import {
  verifyDomainOwnership,
  verifyDomainRouting,
} from "../external/hosted-domain-dns";
import {
  createHostedDomain,
  deleteHostedDomain,
  findHostedDomain,
  readHostedDomain,
  providerDomainRecords,
  hostedDomainIngressConfigured,
} from "../external/hosted-domain-provider";
import { loadOrgPlanCapabilities$ } from "./org-plan-entitlement-read.service";
import { ORG_PLAN_ENTITLEMENT_TIER_VALUES } from "./org-plan-entitlement-tier-values";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}
type SiteArgs = Owner & { readonly siteId: string };
type DomainArgs = SiteArgs & {
  readonly domainId: string;
  readonly expectedRevision: string;
};
type Domain = typeof hostedSiteDomains.$inferSelect;
export class HostedDomainError extends Error {
  constructor(
    readonly status: 400 | 402 | 403 | 404 | 409 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function hostedDomainReady(
  domain: Pick<
    Domain,
    "verifiedAt" | "revokedAt" | "releasedAt" | "verification"
  >,
) {
  return (
    domain.verifiedAt !== null &&
    domain.revokedAt === null &&
    domain.releasedAt === null &&
    domain.verification?.eligibleForSelection === true
  );
}
export const customDomainsAllowed$ = command(
  async ({ set }, orgId: string, signal: AbortSignal) => {
    const capabilities = await set(loadOrgPlanCapabilities$, orgId, signal);
    signal.throwIfAborted();
    const tier = orgTierSchema.safeParse(capabilities?.planKey);
    return (
      capabilities?.status === "active" &&
      tier.success &&
      ORG_PLAN_ENTITLEMENT_TIER_VALUES[tier.data].hostedSiteCustomDomainsAllowed
    );
  },
);
const requireCapability$ = command(
  async ({ set }, args: Owner, signal: AbortSignal) => {
    const context = await set(
      loadUserFeatureSwitchContext$,
      args.orgId,
      args.userId,
      signal,
    );
    signal.throwIfAborted();
    if (
      !isFeatureEnabled(FeatureSwitchKey.HostedSiteCustomDomains, {
        orgId: args.orgId,
        userId: args.userId,
        ...context,
      })
    ) {
      throw new HostedDomainError(
        403,
        "FORBIDDEN",
        "Custom domains are not available for this workspace",
      );
    }
    if (!(await set(customDomainsAllowed$, args.orgId, signal))) {
      throw new HostedDomainError(
        402,
        "PAID_PLAN_REQUIRED",
        "Subscribe to connect and use custom domains",
      );
    }
  },
);
const ownedSite$ = command(
  async ({ get }, args: SiteArgs, signal: AbortSignal) => {
    const [site] = await get(db$)
      .select()
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.id, args.siteId),
          eq(hostedSites.orgId, args.orgId),
          eq(hostedSites.userId, args.userId),
          eq(hostedSites.linkLayoutSegment, "okou"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!site) {
      throw new HostedDomainError(
        404,
        "NOT_FOUND",
        "Published website not found",
      );
    }
    return site;
  },
);
const requirePublished$ = command(
  async (
    { get },
    site: typeof hostedSites.$inferSelect,
    signal: AbortSignal,
  ) => {
    const [deployment] = await get(db$)
      .select({ id: hostedDeployments.id })
      .from(hostedDeployments)
      .where(
        and(
          eq(hostedDeployments.siteId, site.id),
          eq(
            hostedDeployments.id,
            site.activeDeploymentId ?? "00000000-0000-0000-0000-000000000000",
          ),
          eq(hostedDeployments.status, "ready"),
          isNull(sql`${hostedDeployments.manifest}->>'access'`),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (site.deletedAt || !deployment) {
      throw new HostedDomainError(
        404,
        "NOT_FOUND",
        "Published website not found",
      );
    }
  },
);
const ownedDomain$ = command(
  async ({ get }, args: DomainArgs, signal: AbortSignal) => {
    const [domain] = await get(db$)
      .select()
      .from(hostedSiteDomains)
      .where(
        and(
          eq(hostedSiteDomains.siteId, args.siteId),
          eq(hostedSiteDomains.id, args.domainId),
          eq(hostedSiteDomains.revision, args.expectedRevision),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!domain) {
      throw new HostedDomainError(
        409,
        "REVISION_CONFLICT",
        "The domain changed. Reload and try again.",
      );
    }
    return domain;
  },
);
function target() {
  const hostname = env("HOSTED_SITE_CUSTOM_DOMAIN_TARGET");
  if (!hostname) {
    throw new HostedDomainError(
      503,
      "NOT_CONFIGURED",
      "Custom domain DNS target is not configured",
    );
  }
  return hostname;
}
const ensureSettings$ = command(
  async ({ set }, siteId: string, signal: AbortSignal) => {
    await set(writeDb$)
      .insert(hostedSiteDomainSettings)
      .values({ siteId, revision: siteId })
      .onConflictDoNothing();
    signal.throwIfAborted();
  },
);
export const readHostedSiteDomains$ = command(
  async (
    { get, set },
    args: SiteArgs,
    signal: AbortSignal,
  ): Promise<zInfer<typeof hostedDomainSettingsSchema>> => {
    const site = await set(ownedSite$, args, signal);
    signal.throwIfAborted();
    const [storedSettings] = await get(db$)
      .select()
      .from(hostedSiteDomainSettings)
      .where(eq(hostedSiteDomainSettings.siteId, site.id));
    signal.throwIfAborted();
    const settings = storedSettings ?? {
      selectedDomainId: null,
      revision: site.id,
    };
    const domains = await get(db$)
      .select()
      .from(hostedSiteDomains)
      .where(
        and(
          eq(hostedSiteDomains.siteId, site.id),
          isNull(hostedSiteDomains.releasedAt),
        ),
      )
      .orderBy(hostedSiteDomains.createdAt);
    signal.throwIfAborted();
    const allowed = await set(customDomainsAllowed$, site.orgId, signal);
    signal.throwIfAborted();
    const selected = domains.find((domain) => {
      return (
        domain.id === settings.selectedDomainId && hostedDomainReady(domain)
      );
    });
    const defaultUrl = hostedLinkOrigin("current", site.publicSlug);
    return {
      siteId: site.id,
      defaultUrl,
      effectiveUrl:
        allowed && selected ? `https://${selected.hostname}` : defaultUrl,
      selectedDomainId: settings.selectedDomainId,
      revision: settings.revision,
      allowed,
      domains: domains.map((domain) => {
        return {
          id: domain.id,
          hostname: domain.hostname,
          revision: domain.revision,
          ready: hostedDomainReady(domain),
          removing: domain.revokedAt !== null,
          verification: domain.verification,
          records: [
            {
              type: "TXT" as const,
              name: `_okou-challenge.${domain.hostname}`,
              value: `okou-verification=${domain.challenge}`,
            },
            ...(hostedSiteApexHostname(domain.hostname) &&
            env("HOSTED_SITE_CUSTOM_DOMAIN_APEX_ADDRESSES")
              ? env("HOSTED_SITE_CUSTOM_DOMAIN_APEX_ADDRESSES")!
                  .split(",")
                  .map((value) => {
                    return value.trim();
                  })
                  .filter(Boolean)
                  .map((value) => {
                    return {
                      type: value.includes(":")
                        ? ("AAAA" as const)
                        : ("A" as const),
                      name: domain.hostname,
                      value,
                    };
                  })
              : [
                  {
                    type: "CNAME" as const,
                    name: domain.hostname,
                    value: target(),
                  },
                ]),
            ...(domain.verification?.validationRecords ?? []),
          ],
        };
      }),
    };
  },
);
export const addHostedSiteDomain$ = command(
  async (
    { get, set },
    args: SiteArgs & { readonly hostname: string },
    signal: AbortSignal,
  ) => {
    const site = await set(ownedSite$, args, signal);
    signal.throwIfAborted();
    await set(requirePublished$, site, signal);
    signal.throwIfAborted();
    await set(requireCapability$, args, signal);
    signal.throwIfAborted();
    target();
    const hostname = normalizeHostedSiteHostname(args.hostname);
    if (!hostname) {
      throw new HostedDomainError(
        400,
        "INVALID_HOSTNAME",
        "Enter a valid domain you own; URLs, IP addresses, wildcards and reserved hostnames are not supported",
      );
    }
    await set(ensureSettings$, args.siteId, signal);
    signal.throwIfAborted();
    await set(writeDb$)
      .insert(hostedSiteDomains)
      .values({
        siteId: site.id,
        hostname,
        challenge: randomBytes(32).toString("hex"),
        challengeExpiresAt: new Date(
          nowDate().getTime() + 7 * 24 * 60 * 60 * 1000,
        ),
      })
      .onConflictDoNothing();
    signal.throwIfAborted();
    const [domain] = await get(db$)
      .select()
      .from(hostedSiteDomains)
      .where(
        and(
          eq(hostedSiteDomains.siteId, site.id),
          eq(hostedSiteDomains.hostname, hostname),
          isNull(hostedSiteDomains.releasedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!domain) {
      throw new HostedDomainError(
        409,
        "DOMAIN_IN_USE",
        "This domain is already connected to another website",
      );
    }
    if (
      !domain.verifiedAt &&
      domain.challengeExpiresAt <= nowDate() &&
      !domain.revokedAt
    ) {
      await set(writeDb$)
        .update(hostedSiteDomains)
        .set({
          challenge: randomBytes(32).toString("hex"),
          challengeExpiresAt: new Date(
            nowDate().getTime() + 7 * 24 * 60 * 60 * 1000,
          ),
          revision: randomUUID(),
        })
        .where(
          and(
            eq(hostedSiteDomains.id, domain.id),
            eq(hostedSiteDomains.revision, domain.revision),
            or(
              isNull(hostedSiteDomains.verifyingUntil),
              lt(hostedSiteDomains.verifyingUntil, nowDate()),
            ),
          ),
        );
      signal.throwIfAborted();
    }
    return set(readHostedSiteDomains$, args, signal);
  },
);
const notChecked = () => {
  return {
    status: "not_checked" as const,
    message: "Verify to check this step",
  };
};
const claimHostedDomainVerification$ = command(
  async ({ set }, args: DomainArgs, signal: AbortSignal) => {
    const site = await set(ownedSite$, args, signal);
    signal.throwIfAborted();
    await set(requirePublished$, site, signal);
    signal.throwIfAborted();
    await set(requireCapability$, args, signal);
    signal.throwIfAborted();
    const domain = await set(ownedDomain$, args, signal);
    signal.throwIfAborted();
    if (domain.revokedAt || domain.releasedAt) {
      throw new HostedDomainError(
        409,
        "DOMAIN_REMOVING",
        "Finish removing this domain before adding it again",
      );
    }
    if (!domain.verifiedAt && domain.challengeExpiresAt <= nowDate()) {
      throw new HostedDomainError(
        409,
        "CHALLENGE_EXPIRED",
        "Add this hostname again to generate a fresh TXT record",
      );
    }
    const operationId = randomUUID();
    const started = nowDate();
    const [claimed] = await set(writeDb$)
      .update(hostedSiteDomains)
      .set({
        verifyingId: operationId,
        verifyingUntil: new Date(started.getTime() + 15_000),
      })
      .where(
        and(
          eq(hostedSiteDomains.id, domain.id),
          eq(hostedSiteDomains.revision, args.expectedRevision),
          isNull(hostedSiteDomains.revokedAt),
          or(
            isNull(hostedSiteDomains.verifyingUntil),
            lt(hostedSiteDomains.verifyingUntil, started),
          ),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!claimed) {
      throw new HostedDomainError(
        409,
        "VERIFY_IN_PROGRESS",
        "A verification is already in progress. Try again when it finishes.",
      );
    }
    return { domain, operationId, started };
  },
);
const provisionHostedDomain$ = command(
  async (
    { set },
    domain: Domain,
    operationId: string,
    bounded: AbortSignal,
    signal: AbortSignal,
  ) => {
    const providerIntent = await set(writeDb$)
      .update(hostedSiteDomains)
      .set({ providerStarted: true })
      .where(
        and(
          eq(hostedSiteDomains.id, domain.id),
          eq(hostedSiteDomains.verifyingId, operationId),
          isNull(hostedSiteDomains.revokedAt),
        ),
      )
      .returning({ id: hostedSiteDomains.id });
    signal.throwIfAborted();
    if (!providerIntent.length) {
      throw new HostedDomainError(
        409,
        "DOMAIN_CHANGED",
        "The domain changed. Reopen its settings and try again.",
      );
    }
    let provider = domain.providerId
      ? await readHostedDomain(domain.providerId, bounded)
      : null;
    if (!provider) {
      const existing = await findHostedDomain(domain.hostname, bounded);
      signal.throwIfAborted();
      provider =
        existing.find((item) => {
          return item.custom_metadata?.okou_binding_id === domain.id;
        }) ?? null;
      if (existing.length && !provider) {
        throw new HostedDomainError(
          409,
          "DOMAIN_IN_USE",
          "This domain is already connected to another website",
        );
      }
      provider ??= await createHostedDomain(
        domain.hostname,
        domain.id,
        bounded,
      );
    }
    if (
      provider.hostname !== domain.hostname ||
      provider.custom_metadata?.okou_binding_id !== domain.id
    ) {
      throw new HostedDomainError(
        409,
        "DOMAIN_IN_USE",
        "The provider binding does not belong to this website",
      );
    }
    await set(writeDb$)
      .update(hostedSiteDomains)
      .set({ providerId: provider.id })
      .where(
        and(
          eq(hostedSiteDomains.id, domain.id),
          eq(hostedSiteDomains.verifyingId, operationId),
          isNull(hostedSiteDomains.revokedAt),
        ),
      );
    signal.throwIfAborted();
    return provider;
  },
);
async function verifyHostedDomainIngress(
  domain: Domain,
  verification: HostedDomainVerification,
  bounded: AbortSignal,
) {
  // Probe a fixed operator-controlled SaaS ingress. Customer hostnames are
  // data in this narrow challenge, never arbitrary outbound fetch targets.
  const probe = new URL(`https://${target()}/.okou/domain-verification`);
  probe.search = new URLSearchParams({
    domainId: domain.id,
    hostname: domain.hostname,
    proof: domain.challenge,
  }).toString();
  const ingressConfigured = await hostedDomainIngressConfigured(bounded);
  const proof = await fetchHostedDomainJson(
    "ingress",
    probe,
    { headers: { [HOSTED_DOMAIN_PROBE_HEADER]: "1" } },
    bounded,
  );
  const matches =
    ingressConfigured &&
    proof !== null &&
    typeof proof === "object" &&
    "proof" in proof &&
    proof.proof === domain.challenge;
  verification.checks.route = {
    status: matches ? "passed" : "pending",
    message: matches
      ? "Website routing verified"
      : "The domain ingress is not ready. Try Verify again after setup.",
  };
  if (matches) {
    verification.status = "ready";
  }
}
const checkHostedDomain$ = command(
  async (
    { set },
    {
      domain,
      operationId,
    }: { readonly domain: Domain; readonly operationId: string },
    verification: HostedDomainVerification,
    bounded: AbortSignal,
    signal: AbortSignal,
  ) => {
    verification.checks.ownership = await verifyDomainOwnership(
      domain.hostname,
      domain.challenge,
      bounded,
    );
    if (verification.checks.ownership.status === "passed") {
      verification.checks.dns = await verifyDomainRouting(
        domain.hostname,
        target(),
        env("HOSTED_SITE_CUSTOM_DOMAIN_APEX_ADDRESSES")
          ?.split(",")
          .map((value) => {
            return value.trim().toLowerCase();
          })
          .filter(Boolean) ?? [],
        bounded,
      );
      const provider = await set(
        provisionHostedDomain$,
        domain,
        operationId,
        bounded,
        signal,
      );
      signal.throwIfAborted();
      verification.validationRecords = providerDomainRecords(provider);
      verification.checks.provider = {
        status: provider.status === "active" ? "passed" : "pending",
        message:
          provider.status === "active"
            ? "Domain provider is ready"
            : "Domain provider is not ready. Configure any additional TXT records and click Verify again.",
      };
      verification.checks.certificate = {
        status: provider.ssl.status === "active" ? "passed" : "pending",
        message:
          provider.ssl.status === "active"
            ? "HTTPS certificate is active"
            : provider.ssl.validation_errors
                ?.map((error) => {
                  return error.message;
                })
                .join("; ")
                .slice(0, 400) ||
              "HTTPS is not ready yet. Wait, then click Verify again.",
      };
      if (
        [
          verification.checks.dns,
          verification.checks.provider,
          verification.checks.certificate,
        ].every((check) => {
          return check.status === "passed";
        })
      ) {
        await verifyHostedDomainIngress(domain, verification, bounded);
      }
    }
  },
);
const recordHostedDomainFailure$ = command(
  async (
    { set },
    {
      domain,
      operationId,
    }: { readonly domain: Domain; readonly operationId: string },
    verification: HostedDomainVerification,
    error: unknown,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    if (error instanceof HostedDomainError) {
      await set(writeDb$)
        .update(hostedSiteDomains)
        .set({ verifyingId: null, verifyingUntil: null })
        .where(
          and(
            eq(hostedSiteDomains.id, domain.id),
            eq(hostedSiteDomains.verifyingId, operationId),
          ),
        );
      signal.throwIfAborted();
      throw error;
    }
    if (
      !(error instanceof HostedDomainDependencyError) &&
      !(error instanceof ZodError)
    ) {
      throw error;
    }
    verification.status = "unavailable";
    if (
      error instanceof HostedDomainDependencyError &&
      error.dependency === "provider" &&
      error.status === 404
    ) {
      verification.status = "incomplete";
      verification.checks.provider = {
        status: "failed",
        message:
          "The provider binding was removed. Remove and reconnect this domain.",
      };
    }
    const check = Object.values(verification.checks).find((item) => {
      return item.status === "not_checked" || item.status === "pending";
    });
    if (check) {
      check.status = "unavailable";
      check.message =
        "We couldn’t finish checking your domain. Click Verify to try again.";
    }
  },
);
const persistHostedDomainVerification$ = command(
  async (
    { set },
    domain: Domain,
    operationId: string,
    verification: HostedDomainVerification,
    signal: AbortSignal,
  ) => {
    verification.eligibleForSelection =
      verification.status === "ready" ||
      (domain.verifiedAt !== null &&
        verification.status === "unavailable" &&
        !Object.values(verification.checks).some((check) => {
          return check.status === "failed" || check.status === "pending";
        }));
    const persisted = await settle(
      set(writeDb$)
        .update(hostedSiteDomains)
        .set({
          verification,
          verifiedAt:
            verification.status === "ready"
              ? (domain.verifiedAt ?? nowDate())
              : domain.verifiedAt,
          verifyingId: null,
          verifyingUntil: null,
        })
        .where(
          and(
            eq(hostedSiteDomains.id, domain.id),
            eq(hostedSiteDomains.verifyingId, operationId),
            eq(hostedSiteDomains.revision, domain.revision),
            isNull(hostedSiteDomains.revokedAt),
          ),
        )
        .returning({ id: hostedSiteDomains.id }),
      signal,
    );
    signal.throwIfAborted();
    if (!persisted.ok) {
      const error = persisted.error;
      if (isUniqueViolation(error, "hosted_site_domains_verified_hostname")) {
        throw new HostedDomainError(
          409,
          "DOMAIN_IN_USE",
          "This domain is already connected to another website",
        );
      }
      throw error;
    }
    if (!persisted.value[0]) {
      throw new HostedDomainError(
        409,
        "REVISION_CONFLICT",
        "The domain changed while verification was running",
      );
    }
  },
);
export const verifyHostedSiteDomain$ = command(
  async ({ set }, args: DomainArgs, signal: AbortSignal) => {
    const { domain, operationId, started } = await set(
      claimHostedDomainVerification$,
      args,
      signal,
    );
    signal.throwIfAborted();
    const verification: HostedDomainVerification = {
      status: "incomplete",
      eligibleForSelection: false,
      checkedAt: started.toISOString(),
      validationRecords: domain.verification?.validationRecords ?? [],
      checks: {
        ownership: notChecked(),
        dns: notChecked(),
        provider: notChecked(),
        certificate: notChecked(),
        route: notChecked(),
      },
    };
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
    const attempt = await settleIncludingAbort(
      set(
        checkHostedDomain$,
        { domain, operationId },
        verification,
        bounded,
        signal,
      ),
    );
    signal.throwIfAborted();
    if (!attempt.ok) {
      await set(
        recordHostedDomainFailure$,
        { domain, operationId },
        verification,
        attempt.error,
        signal,
      );
    }
    signal.throwIfAborted();
    await set(
      persistHostedDomainVerification$,
      domain,
      operationId,
      verification,
      signal,
    );
    signal.throwIfAborted();
    return set(readHostedSiteDomains$, args, signal);
  },
);
export const selectHostedSiteDomain$ = command(
  async (
    { set },
    args: SiteArgs & {
      readonly domainId: string | null;
      readonly expectedRevision: string;
      readonly publicSlug?: string;
      readonly expectedPublicSlug?: string;
    },
    signal: AbortSignal,
  ) => {
    const site = await set(ownedSite$, args, signal);
    signal.throwIfAborted();
    await set(ensureSettings$, args.siteId, signal);
    signal.throwIfAborted();
    await set(requirePublished$, site, signal);
    signal.throwIfAborted();
    if (args.domainId) {
      await set(requireCapability$, args, signal);
    }
    signal.throwIfAborted();
    const db = set(writeDb$);
    const eligible = db
      .select({ id: hostedSiteDomains.id })
      .from(hostedSiteDomains)
      .where(
        and(
          eq(hostedSiteDomains.siteId, site.id),
          eq(
            hostedSiteDomains.id,
            args.domainId ?? "00000000-0000-0000-0000-000000000000",
          ),
          isNotNull(hostedSiteDomains.verifiedAt),
          isNull(hostedSiteDomains.revokedAt),
          isNull(hostedSiteDomains.releasedAt),
          sql`${hostedSiteDomains.verification}->>'eligibleForSelection' = 'true'`,
        ),
      );
    const publicSlug =
      args.domainId === null
        ? (args.publicSlug ?? site.publicSlug)
        : site.publicSlug;
    if (publicSlug !== site.publicSlug) {
      await set(requireCapability$, args, signal);
      signal.throwIfAborted();
      if (!(await set(availableForSite$, site, publicSlug, signal))) {
        throw new HostedDomainError(
          409,
          "DOMAIN_IN_USE",
          "This website address is already taken",
        );
      }
    }
    const selected = db.$with("selected_address").as(
      db
        .update(hostedSiteDomainSettings)
        .set({ selectedDomainId: args.domainId, revision: randomUUID() })
        .where(
          and(
            eq(hostedSiteDomainSettings.siteId, site.id),
            eq(hostedSiteDomainSettings.revision, args.expectedRevision),
            args.domainId ? exists(eligible) : undefined,
            exists(
              db
                .select({ id: hostedSites.id })
                .from(hostedSites)
                .where(
                  and(
                    eq(hostedSites.id, site.id),
                    eq(
                      hostedSites.publicSlug,
                      args.expectedPublicSlug ?? site.publicSlug,
                    ),
                    isNull(hostedSites.deletedAt),
                  ),
                ),
            ),
          ),
        )
        .returning({ siteId: hostedSiteDomainSettings.siteId }),
    );
    const renamed = db.$with("renamed_address").as(
      db
        .update(hostedSites)
        .set({ publicSlug })
        .where(
          and(
            eq(hostedSites.id, site.id),
            exists(db.select({ siteId: selected.siteId }).from(selected)),
          ),
        )
        .returning({ id: hostedSites.id }),
    );
    const updated = await settle(
      db
        .with(selected, renamed)
        .select({ siteId: selected.siteId })
        .from(selected)
        .innerJoin(renamed, eq(renamed.id, selected.siteId)),
      signal,
    );
    signal.throwIfAborted();
    if (!updated.ok) {
      if (isUniqueViolation(updated.error, "idx_hosted_sites_public_slug")) {
        throw new HostedDomainError(
          409,
          "DOMAIN_IN_USE",
          "This website address is already taken",
        );
      }
      throw updated.error;
    }
    if (!updated.value.length) {
      throw new HostedDomainError(
        409,
        "REVISION_CONFLICT",
        "The address changed or this domain is not ready. Reload and try again.",
      );
    }
    return set(readHostedSiteDomains$, args, signal);
  },
);
export const removeHostedSiteDomain$ = command(
  async ({ set }, args: DomainArgs, signal: AbortSignal) => {
    const site = await set(ownedSite$, args, signal);
    signal.throwIfAborted();
    const domain = await set(ownedDomain$, args, signal);
    signal.throwIfAborted();
    if (domain.releasedAt) {
      return set(readHostedSiteDomains$, args, signal);
    }
    // A late completion cannot race removal or publish an unrecorded provider ID.
    if (domain.verifyingUntil && domain.verifyingUntil > nowDate()) {
      throw new HostedDomainError(
        409,
        "VERIFY_IN_PROGRESS",
        "Wait for verification to finish before removing this domain",
      );
    }
    const db = set(writeDb$);
    const revoked = db.$with("revoked_domain").as(
      db
        .update(hostedSiteDomains)
        .set({
          revokedAt: domain.revokedAt ?? nowDate(),
          verifyingId: null,
          verifyingUntil: null,
        })
        .where(
          and(
            eq(hostedSiteDomains.id, domain.id),
            eq(hostedSiteDomains.revision, args.expectedRevision),
            or(
              isNull(hostedSiteDomains.verifyingUntil),
              lt(hostedSiteDomains.verifyingUntil, nowDate()),
            ),
          ),
        )
        .returning({ id: hostedSiteDomains.id }),
    );
    const fallback = db.$with("fallback_address").as(
      db
        .update(hostedSiteDomainSettings)
        .set({
          selectedDomainId: sql`CASE WHEN ${hostedSiteDomainSettings.selectedDomainId} = ${domain.id} THEN NULL ELSE ${hostedSiteDomainSettings.selectedDomainId} END`,
          revision: randomUUID(),
        })
        .where(
          and(
            eq(hostedSiteDomainSettings.siteId, site.id),
            exists(db.select({ id: revoked.id }).from(revoked)),
          ),
        )
        .returning({ siteId: hostedSiteDomainSettings.siteId }),
    );
    const sessions = db.$with("revoked_domain_sessions").as(
      db
        .delete(hostedSiteBrowserSessions)
        .where(
          and(
            eq(hostedSiteBrowserSessions.siteId, site.id),
            eq(hostedSiteBrowserSessions.origin, `https://${domain.hostname}`),
            exists(db.select({ id: revoked.id }).from(revoked)),
          ),
        )
        .returning({ id: hostedSiteBrowserSessions.id }),
    );
    const rows = await db
      .with(revoked, fallback, sessions)
      .select({ id: revoked.id })
      .from(revoked);
    signal.throwIfAborted();
    if (!rows.length) {
      throw new HostedDomainError(
        409,
        "VERIFY_IN_PROGRESS",
        "Wait for verification to finish before removing this domain",
      );
    }
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
    const cleanup = await settleIncludingAbort(async () => {
      if (domain.providerStarted) {
        const candidates = await findHostedDomain(domain.hostname, bounded);
        signal.throwIfAborted();
        const provider = candidates.find((item) => {
          return item.custom_metadata?.okou_binding_id === domain.id;
        });
        if (
          provider &&
          domain.providerId &&
          provider.id !== domain.providerId
        ) {
          throw new HostedDomainError(
            503,
            "DOMAIN_CLEANUP_PENDING",
            "The provider binding changed. Keep the hostname reserved until cleanup is confirmed.",
          );
        }
        if (provider) {
          await deleteHostedDomain(provider.id, bounded);
        }
        signal.throwIfAborted();
      }
    });
    signal.throwIfAborted();
    if (!cleanup.ok) {
      throw new HostedDomainError(
        503,
        "DOMAIN_CLEANUP_PENDING",
        "The domain is disconnected. Click Remove again to finish provider cleanup.",
      );
    }
    await db
      .update(hostedSiteDomains)
      .set({ releasedAt: nowDate() })
      .where(
        and(
          eq(hostedSiteDomains.id, domain.id),
          isNotNull(hostedSiteDomains.revokedAt),
        ),
      );
    signal.throwIfAborted();
    return set(readHostedSiteDomains$, args, signal);
  },
);
export const resolveHostedCustomDomain$ = command(
  async ({ get, set }, hostname: string, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select({ domain: hostedSiteDomains, site: hostedSites })
      .from(hostedSiteDomains)
      .innerJoin(hostedSites, eq(hostedSiteDomains.siteId, hostedSites.id))
      .where(
        and(
          eq(hostedSiteDomains.hostname, hostname),
          isNull(hostedSites.deletedAt),
          isNull(hostedSiteDomains.revokedAt),
          isNull(hostedSiteDomains.releasedAt),
          isNotNull(hostedSiteDomains.verifiedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (
      !row ||
      !hostedDomainReady(row.domain) ||
      !(await set(customDomainsAllowed$, row.site.orgId, signal))
    ) {
      return null;
    }
    return {
      siteId: row.site.id,
      publicSlug: row.site.publicSlug,
      revision: row.domain.revision,
    };
  },
);
export const hostedDomainProbe$ = command(
  async (
    { get, set },
    args: {
      readonly domainId: string;
      readonly hostname: string;
      readonly proof: string;
    },
    signal: AbortSignal,
  ) => {
    const [row] = await get(db$)
      .select({ domain: hostedSiteDomains, orgId: hostedSites.orgId })
      .from(hostedSiteDomains)
      .innerJoin(hostedSites, eq(hostedSites.id, hostedSiteDomains.siteId))
      .where(
        and(
          eq(hostedSiteDomains.id, args.domainId),
          eq(hostedSiteDomains.hostname, args.hostname),
          eq(hostedSiteDomains.challenge, args.proof),
          isNull(hostedSites.deletedAt),
          isNull(hostedSiteDomains.revokedAt),
          isNull(hostedSiteDomains.releasedAt),
          isNotNull(hostedSiteDomains.verifyingId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return {
      proof:
        row &&
        row.domain.verifyingUntil &&
        row.domain.verifyingUntil > nowDate() &&
        (await set(customDomainsAllowed$, row.orgId, signal))
          ? args.proof
          : null,
    };
  },
);
export const selectedHostedCustomUrl$ = command(
  async ({ get, set }, siteId: string, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select({ domain: hostedSiteDomains })
      .from(hostedSiteDomainSettings)
      .innerJoin(
        hostedSiteDomains,
        and(
          eq(hostedSiteDomainSettings.selectedDomainId, hostedSiteDomains.id),
          eq(hostedSiteDomainSettings.siteId, hostedSiteDomains.siteId),
        ),
      )
      .where(eq(hostedSiteDomainSettings.siteId, siteId))
      .limit(1);
    signal.throwIfAborted();
    if (!row || !hostedDomainReady(row.domain)) {
      return null;
    }
    return (await set(resolveHostedCustomDomain$, row.domain.hostname, signal))
      ? `https://${row.domain.hostname}`
      : null;
  },
);
