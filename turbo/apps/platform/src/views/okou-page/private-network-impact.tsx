import { useTranslation } from "react-i18next";
import type { CloudflareAccessImpactPreview } from "@okouai/api-contracts/contracts/cloudflare-access";

export function PrivateNetworkAffectedMembers({
  preview,
}: {
  readonly preview: CloudflareAccessImpactPreview;
}) {
  const { t } = useTranslation();
  if (preview.otherHostCount === 0) {
    return null;
  }
  const nameCounts = new Map<string, number>();
  const suffixCounts = new Map<string, number>();
  for (const owner of preview.affectedOwners) {
    if (owner.displayName) {
      nameCounts.set(
        owner.displayName,
        (nameCounts.get(owner.displayName) ?? 0) + 1,
      );
    }
    const suffix = owner.userId.slice(-8);
    suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
  }
  return (
    <>
      <p role="alert">
        {t(
          ($) => {
            return $.vnc.native.impactSummary;
          },
          {
            members: t(
              ($) => {
                return $.cloudflareAccess.affectedMembers;
              },
              { count: preview.affectedOwners.length },
            ),
            hosts: t(
              ($) => {
                return $.vnc.native.hostCount;
              },
              { count: preview.otherHostCount },
            ),
          },
        )}
      </p>
      <ul className="list-inside list-disc">
        {preview.affectedOwners.map(({ userId, displayName }) => {
          const ambiguous =
            !displayName || (nameCounts.get(displayName) ?? 0) > 1;
          const tail = userId.slice(-8);
          const identifier =
            (suffixCounts.get(tail) ?? 0) > 1 ? userId : `…${tail}`;
          return (
            <li key={userId}>
              {displayName ??
                t(($) => {
                  return $.cloudflareAccess.nameUnavailable;
                })}
              {ambiguous &&
                t(
                  ($) => {
                    return $.cloudflareAccess.memberIdentifier;
                  },
                  { identifier },
                )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
