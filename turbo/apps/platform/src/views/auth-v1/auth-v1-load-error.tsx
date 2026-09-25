import { Button, Card } from "@okouai/ui";
import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { hideAppSkeletonOnContentReadyRef$ } from "../../signals/app-skeleton.ts";
import { resolveAuthBrandContext } from "../../signals/auth.ts";
import { AuthV1Layout } from "./auth-v1-layout.tsx";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";

export function AuthV1LoadError() {
  const { t } = useTranslation();
  const contentReady = useSet(hideAppSkeletonOnContentReadyRef$);
  const authBrand = resolveAuthBrandContext();
  const supportEmail = PUBLIC_BRAND_PRESENTATION.contactEmail;
  return (
    <AuthV1Layout authBrand={authBrand}>
      <div className="flex w-[var(--okou-auth-card-page-width)] max-w-[var(--okou-auth-card-max-width)] flex-col items-center gap-5">
        <ProductBrandMark size="compact" />
        <Card
          className="flex w-full flex-col gap-4 p-8 text-center"
          role="alert"
        >
          <h1 className="text-lg font-medium">
            {t(($) => {
              return $.shared.errorBoundary.title;
            })}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.shared.errorBoundary.description;
            })}{" "}
            <a
              className="text-brand-text underline underline-offset-4"
              href={`mailto:${supportEmail}`}
            >
              {t(($) => {
                return $.shared.errorBoundary.contactSupport;
              })}
            </a>
          </p>
          <Button
            className="border-0 py-0 bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-pressed text-[length:var(--text-action)] leading-[var(--text-action--line-height)]"
            onClick={() => {
              return window.location.reload();
            }}
          >
            {t(($) => {
              return $.shared.forceUpgrade.action;
            })}
          </Button>
          <span ref={contentReady} hidden />
        </Card>
      </div>
    </AuthV1Layout>
  );
}
