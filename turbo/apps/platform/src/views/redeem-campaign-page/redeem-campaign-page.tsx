import type { ReactNode } from "react";
import { useGet, useLastLoadable } from "ccstate-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Check, Gift, Loader2, Lock, X } from "lucide-react";
import { buttonVariants, cn } from "@okouai/ui";
import type { RedeemResponse } from "@okouai/api-contracts/contracts/billing";
import {
  redeemResponse$,
  redeemStripeSuccess$,
} from "../../signals/redeem-campaign/redeem-campaign-signals.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { clerk$ } from "../../signals/auth.ts";
import { brandName$ } from "../../signals/branding.ts";
import { Link } from "../router/link.tsx";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";

type CardKind = "ready" | "granted" | "processing" | "auth" | "broken";

interface CardInfo {
  kind: CardKind;
  title: string;
  body: string;
}

function resolveCard(
  response: RedeemResponse | null,
  stripeSuccess: boolean,
  orgName: string,
  t: TFunction<"common">,
): CardInfo {
  if (stripeSuccess) {
    return {
      kind: "granted",
      title: t(($) => {
        return $.lifecycle.redeemCampaign.states.paymentSuccessful.title;
      }),
      body: t(
        ($) => {
          return $.lifecycle.redeemCampaign.states.paymentSuccessful.body;
        },
        { orgName },
      ),
    };
  }
  if (!response) {
    return {
      kind: "broken",
      title: t(($) => {
        return $.lifecycle.redeemCampaign.states.broken.title;
      }),
      body: t(($) => {
        return $.lifecycle.redeemCampaign.states.broken.body;
      }),
    };
  }
  switch (response.status) {
    case "ready": {
      return {
        kind: "ready",
        title: t(($) => {
          return $.lifecycle.redeemCampaign.states.ready.title;
        }),
        body: t(
          ($) => {
            return $.lifecycle.redeemCampaign.states.ready.body;
          },
          { orgName },
        ),
      };
    }
    case "already_granted": {
      return {
        kind: "granted",
        title: t(($) => {
          return $.lifecycle.redeemCampaign.states.alreadyGranted.title;
        }),
        body: t(
          ($) => {
            return $.lifecycle.redeemCampaign.states.alreadyGranted.body;
          },
          { orgName },
        ),
      };
    }
    case "processing": {
      return {
        kind: "processing",
        title: t(($) => {
          return $.lifecycle.redeemCampaign.states.processing.title;
        }),
        body: t(
          ($) => {
            return $.lifecycle.redeemCampaign.states.processing.body;
          },
          { orgName },
        ),
      };
    }
    case "error": {
      switch (response.reason) {
        case "billing_unavailable": {
          return {
            kind: "broken",
            title: t(($) => {
              return $.lifecycle.redeemCampaign.states.billingUnavailable.title;
            }),
            body: t(($) => {
              return $.lifecycle.redeemCampaign.states.billingUnavailable.body;
            }),
          };
        }
        case "admin_required": {
          return {
            kind: "auth",
            title: t(($) => {
              return $.lifecycle.redeemCampaign.states.adminRequired.title;
            }),
            body: t(
              ($) => {
                return $.lifecycle.redeemCampaign.states.adminRequired.body;
              },
              { orgName },
            ),
          };
        }
        case "campaign_misconfigured": {
          return {
            kind: "broken",
            title: t(($) => {
              return $.lifecycle.redeemCampaign.states.campaignUnavailable
                .title;
            }),
            body: t(($) => {
              return $.lifecycle.redeemCampaign.states.campaignUnavailable.body;
            }),
          };
        }
      }
    }
  }
}

function CardIcon({ kind }: { kind: CardKind }): ReactNode {
  switch (kind) {
    case "ready": {
      return <Gift size={40} className="opacity-80" />;
    }
    case "granted": {
      return <Check size={40} className="text-green-600 opacity-80" />;
    }
    case "processing": {
      return <Loader2 size={40} className="animate-spin" />;
    }
    case "auth": {
      return <Lock size={40} className="opacity-70" />;
    }
    case "broken": {
      return <X size={40} className="text-destructive opacity-70" />;
    }
  }
}

function PrimaryAction({
  response,
  stripeSuccess,
}: {
  response: RedeemResponse | null;
  stripeSuccess: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const brandName = useGet(brandName$);

  if (!stripeSuccess && response?.status === "ready") {
    // Keep a semantic <a> so the browser handles cmd/ctrl+click,
    // middle-click, and right-click → "open in new tab" natively. A plain
    // onClick with `window.location.assign` swallows those modifier clicks.
    const checkoutUrl = response.checkoutUrl;
    return (
      <a href={checkoutUrl} className={cn(buttonVariants(), "w-full")}>
        {t(($) => {
          return $.lifecycle.redeemCampaign.actions.redeem;
        })}
      </a>
    );
  }

  // `granted` / `processing` / `stripeSuccess` send the user to the dashboard
  // where the new credit balance is visible. Error cards just send them home.
  return (
    <Link pathname={ROUTES.home} className={cn(buttonVariants(), "w-full")}>
      {t(
        ($) => {
          return $.lifecycle.redeemCampaign.actions.back;
        },
        { brandName },
      )}
    </Link>
  );
}

export function RedeemCampaignPage() {
  const { t } = useTranslation();
  const response = useGet(redeemResponse$);
  const stripeSuccess = useGet(redeemStripeSuccess$);
  const clerkLoadable = useLastLoadable(clerk$);
  const clerk = clerkLoadable.state === "hasData" ? clerkLoadable.data : null;
  const orgName =
    clerk?.organization?.name ??
    t(($) => {
      return $.lifecycle.redeemCampaign.organizationFallback;
    });
  const info = resolveCard(response, stripeSuccess, orgName, t);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="flex w-[500px] max-w-full flex-col items-center gap-10 rounded-[20px] border border-border bg-background px-[50px] py-12">
        <ProductBrandMark />
        <div className="flex flex-col items-center gap-4">
          <CardIcon kind={info.kind} />
          <p className="text-center text-lg font-medium leading-7 text-foreground">
            {info.title}
          </p>
          <p className="text-center text-sm text-muted-foreground">
            {info.body}
          </p>
        </div>
        <PrimaryAction response={response} stripeSuccess={stripeSuccess} />
      </div>
    </div>
  );
}
