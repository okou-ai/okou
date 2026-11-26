import type { hostedDomainSchema } from "@okouai/api-contracts/contracts/hosted-site-domains";
import type { infer as zInfer } from "zod";

export type HostedSiteDomain = zInfer<typeof hostedDomainSchema>;
export type DomainSetupStage = 0 | 1 | 2;

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
  const matchedRecords = domain.records.filter((record) => {
    return domainRecordCheck(domain, record)?.status === "passed";
  });
  const remainingRecords = domain.records.filter((record) => {
    return domainRecordCheck(domain, record)?.status !== "passed";
  });
  const needsDns =
    !domain.verification ||
    remainingRecords.some((record) => {
      const status = domainRecordCheck(domain, record)?.status;
      return status === "pending" || status === "failed";
    });
  const initialStage: DomainSetupStage = domain.ready ? 2 : needsDns ? 0 : 1;
  return {
    initialStage,
    matchedRecords,
    remainingRecords,
    dnsMatched: domain.records.length > 0 && remainingRecords.length === 0,
    certificateOnly:
      remainingRecords.length > 0 &&
      remainingRecords.every((record) => {
        return domain.verification?.validationRecords.some((validation) => {
          return (
            validation.type === record.type &&
            validation.name === record.name &&
            validation.value === record.value
          );
        });
      }),
  };
}
