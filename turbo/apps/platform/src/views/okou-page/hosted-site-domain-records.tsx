import { Collapsible } from "@base-ui/react/collapsible";
import { useGet, useSet } from "ccstate-react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { IconButton } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import type { HostedSiteDomain } from "../../lib/hosted-site-domains.ts";
import type { HostedSiteShareSession } from "../../signals/hosted-site-sharing.ts";
import { detach, Reason } from "../../signals/utils.ts";

interface DomainRecordsProps {
  readonly session: HostedSiteShareSession;
  readonly domain: HostedSiteDomain;
  readonly records: HostedSiteDomain["records"];
}

function DomainRecord({
  session,
  domain,
  record,
}: Omit<DomainRecordsProps, "records"> & {
  readonly record: HostedSiteDomain["records"][number];
}) {
  const { t } = useTranslation();
  const copy = useSet(session.domains.copy$);
  const signal = useGet(session.signal$);
  const certificate = domain.verification?.validationRecords.some((item) => {
    return (
      item.type === record.type &&
      item.name === record.name &&
      item.value === record.value
    );
  });
  if (!signal) {
    return null;
  }
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-md bg-gray-50 px-2 py-1 font-medium">
          {record.type}
        </span>
        <span className="min-w-0 flex-1 text-muted-foreground">
          {certificate
            ? t(($) => {
                return $.artifacts.customDomain.checks.certificate;
              })
            : record.type === "TXT" &&
                record.name === `_okou-challenge.${domain.hostname}`
              ? t(($) => {
                  return $.artifacts.customDomain.checks.ownership;
                })
              : t(($) => {
                  return $.artifacts.customDomain.checks.dns;
                })}
        </span>
      </div>
      <div className="space-y-1">
        {(["name", "value"] as const).map((field) => {
          return (
            <div key={field} className="flex items-start gap-2">
              <span className="w-10 shrink-0 pt-2 text-xs text-muted-foreground">
                {field === "name"
                  ? t(($) => {
                      return $.artifacts.customDomain.recordName;
                    })
                  : t(($) => {
                      return $.artifacts.customDomain.recordValue;
                    })}
              </span>
              <code className="min-w-0 flex-1 break-all py-2 text-xs leading-5">
                {record[field]}
              </code>
              <IconButton
                className="shrink-0"
                aria-label={
                  field === "name"
                    ? t(
                        ($) => {
                          return $.artifacts.customDomain.copyRecordName;
                        },
                        { type: record.type, name: record.name },
                      )
                    : t(
                        ($) => {
                          return $.artifacts.customDomain.copyRecordValue;
                        },
                        { type: record.type, name: record.name },
                      )
                }
                onClick={() => {
                  detach(copy(record[field], signal), Reason.DomCallback);
                }}
              >
                <Copy size={14} />
              </IconButton>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DomainRecords({
  session,
  domain,
  records,
}: DomainRecordsProps) {
  const { t } = useTranslation();
  const sharedTxt = records.some((record) => {
    return (
      record.type === "TXT" &&
      domain.records.some((other) => {
        return (
          other.type === "TXT" &&
          other.name === record.name &&
          other.value !== record.value
        );
      })
    );
  });
  return (
    <div className="space-y-3">
      {sharedTxt && (
        <p className="text-xs leading-5 text-muted-foreground">
          {t(($) => {
            return $.artifacts.customDomain.keepTxtValues;
          })}
        </p>
      )}
      {records.map((record) => {
        return (
          <DomainRecord
            key={`${record.type}-${record.name}-${record.value}`}
            session={session}
            domain={domain}
            record={record}
          />
        );
      })}
    </div>
  );
}

export function VerifiedDomainRecords(props: DomainRecordsProps) {
  const { t } = useTranslation();
  if (props.records.length === 0) {
    return null;
  }
  return (
    <Collapsible.Root className="group/records">
      <Collapsible.Trigger className="flex w-full items-center gap-2 rounded-lg py-2 text-left text-xs hover:bg-gray-50">
        <Check size={14} className="shrink-0 text-green-600" aria-hidden />
        <span className="flex-1">
          {t(
            ($) => {
              return $.artifacts.customDomain.verifiedRecords;
            },
            { total: props.records.length },
          )}
        </span>
        <ChevronDown
          size={14}
          className="shrink-0 text-muted-foreground group-data-[open]/records:rotate-180"
          aria-hidden
        />
      </Collapsible.Trigger>
      <Collapsible.Panel className="pt-3">
        <DomainRecords {...props} />
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
