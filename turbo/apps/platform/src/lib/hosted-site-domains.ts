import type { hostedDomainSchema } from "@okouai/api-contracts/contracts/hosted-site-domains";
import type { infer as zInfer } from "zod";

export type HostedSiteDomain = zInfer<typeof hostedDomainSchema>;

export function domainVerificationDeadline(domain: HostedSiteDomain) {
  const automatic = domain.verification?.automatic;
  return automatic?.status === "checking" ? automatic.expiresAt : undefined;
}

export function domainVerificationTimedOut(
  domain: HostedSiteDomain,
  expiredThrough: number,
) {
  const deadline = domainVerificationDeadline(domain);
  return (
    domain.verification?.automatic?.status === "timed_out" ||
    (deadline !== undefined && Date.parse(deadline) <= expiredThrough)
  );
}

export function domainRecordCheck(
  domain: HostedSiteDomain,
  record: HostedSiteDomain["records"][number],
) {
  return domain.verification?.recordChecks.find((check) => {
    return (
      check.type === record.type &&
      check.name === record.name &&
      check.value === record.value
    );
  });
}

export function hostedDomainProgress(domain: HostedSiteDomain) {
  const verification = domain.verification;
  const remaining = domain.records.filter((record) => {
    return domainRecordCheck(domain, record)?.status !== "passed";
  });
  const certificateOnly =
    remaining.length > 0 &&
    remaining.every((record) => {
      return verification?.validationRecords.some((validation) => {
        return (
          validation.type === record.type &&
          validation.name === record.name &&
          validation.value === record.value
        );
      });
    });
  const dnsConfigured =
    domain.ready ||
    (verification?.checks.ownership.status === "passed" &&
      verification.checks.dns.status === "passed" &&
      remaining.length === 0);
  return { dnsConfigured, certificateOnly };
}
