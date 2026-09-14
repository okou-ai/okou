import { useLastResolved, useSet } from "ccstate-react";
import { currentOrgInfo$, user$ } from "../../signals/auth.ts";
import { setImpactMarketingFrame$ } from "../../signals/bootstrap/impact-marketing.ts";

export function ImpactMarketingFrame() {
  const user = useLastResolved(user$);
  const org = useLastResolved(currentOrgInfo$);
  const ref = useSet(setImpactMarketingFrame$);
  if (!user || !org) {
    return null;
  }
  return (
    <iframe
      key={`${user.id}:${org.id}`}
      ref={ref}
      hidden
      aria-hidden="true"
      role="presentation"
      tabIndex={-1}
      sandbox="allow-scripts allow-same-origin"
      referrerPolicy="no-referrer"
    />
  );
}
