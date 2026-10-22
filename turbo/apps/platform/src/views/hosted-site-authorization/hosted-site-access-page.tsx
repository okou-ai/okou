import { Button, buttonVariants } from "@okouai/ui";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ArrowLeft, ArrowRightLeft, LogIn } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { HostedSiteAccessReason } from "@okouai/api-contracts/contracts/hosted-site-access";
import { hostedSiteSignInUrl } from "../../lib/hosted-site-access.ts";
import { currentUserInfo$ } from "../../signals/auth.ts";
import { BRAND_NAME } from "../../signals/branding.ts";
import { openClerkAddAccount$ } from "../../signals/clerk-add-account.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { shellDocumentAttributesRef$ } from "../../signals/theme.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import { ResourceAccessCard } from "../components/resource-access-card.tsx";

export function HostedSiteAccessCard({
  target,
  reason,
}: {
  readonly target: URL | null;
  readonly reason: HostedSiteAccessReason;
}) {
  const { t } = useTranslation();
  const user = useLastResolved(currentUserInfo$);
  const pageSignal = useGet(pageSignal$);
  const [switching, switchAccount] = useLoadableSet(openClerkAddAccount$);
  const title =
    reason === "expired"
      ? t(($) => {
          return $.artifacts.access.sessionExpiredTitle;
        })
      : reason === "unavailable"
        ? t(($) => {
            return $.artifacts.access.websiteUnavailableTitle;
          })
        : t(($) => {
            return $.artifacts.access.websiteTitle;
          });
  const description =
    reason === "expired"
      ? t(($) => {
          return $.artifacts.access.sessionExpiredDescription;
        })
      : reason === "unavailable"
        ? t(($) => {
            return $.artifacts.access.websiteUnavailableDescription;
          })
        : user
          ? t(($) => {
              return $.artifacts.access.signedInDescription;
            })
          : t(($) => {
              return $.artifacts.access.description;
            });
  return (
    <div className="h-full overflow-y-auto">
      <ResourceAccessCard
        title={title}
        description={description}
        help={
          reason === "denied"
            ? t(($) => {
                return $.artifacts.access.help;
              })
            : undefined
        }
        email={user?.primaryEmailAddress?.emailAddress}
        error={
          switching.state === "hasError"
            ? t(($) => {
                return $.artifacts.access.switchAccountFailed;
              })
            : undefined
        }
      >
        {target && (
          <a
            href={
              reason === "unavailable"
                ? target.href
                : hostedSiteSignInUrl(target)
            }
            className={buttonVariants({
              variant: user ? "outline" : "default",
            })}
          >
            {!user && reason !== "unavailable" && <LogIn aria-hidden />}
            {reason === "unavailable"
              ? t(($) => {
                  return $.artifacts.access.tryAgain;
                })
              : !user
                ? t(($) => {
                    return $.artifacts.access.signIn;
                  })
                : reason === "denied"
                  ? t(($) => {
                      return $.artifacts.access.tryAgain;
                    })
                  : t(($) => {
                      return $.artifacts.access.continue;
                    })}
          </a>
        )}
        {user && reason !== "unavailable" && (
          <Button
            variant="outline"
            disabled={switching.state === "loading"}
            aria-busy={switching.state === "loading"}
            onClick={() => {
              detach(
                switchAccount(location.href, pageSignal),
                Reason.DomCallback,
              );
            }}
          >
            <ArrowRightLeft aria-hidden />
            {t(($) => {
              return $.artifacts.access.switchAccount;
            })}
          </Button>
        )}
      </ResourceAccessCard>
    </div>
  );
}

export function HostedSiteAccessPage({
  target,
  reason,
}: {
  readonly target: URL | null;
  readonly reason: HostedSiteAccessReason;
}) {
  const { t } = useTranslation();
  const mountRef = useSet(shellDocumentAttributesRef$);
  return (
    <div
      ref={mountRef}
      className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground"
    >
      <header className="relative z-10 flex h-14 shrink-0 items-center gap-3 border-b border-border/70 bg-background px-3 sm:gap-4 sm:px-6">
        <a
          href="/"
          aria-label={BRAND_NAME}
          className="shrink-0 text-foreground hover:opacity-70"
        >
          <ProductBrandMark size="small" />
        </a>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
          {t(($) => {
            return $.artifacts.templates.website;
          })}
        </h1>
        <a
          href="/"
          className={buttonVariants({ variant: "quiet", size: "sm" })}
        >
          <ArrowLeft aria-hidden />
          {t(
            ($) => {
              return $.artifacts.access.backToBrand;
            },
            { brandName: BRAND_NAME },
          )}
        </a>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto bg-muted/30">
        <HostedSiteAccessCard target={target} reason={reason} />
      </main>
    </div>
  );
}
