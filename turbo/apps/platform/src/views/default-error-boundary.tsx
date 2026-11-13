import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { Button, Card } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { setTheme$, theme$ } from "../signals/theme.ts";
import { ProductBrandMark } from "./components/product-brand-mark.tsx";

export function DefaultErrorFallback() {
  const { t } = useTranslation();
  const theme = useGet(theme$);
  const setTheme = useSet(setTheme$);
  const contactEmail = BRAND_PRESENTATION.contactEmail;

  // Keep this last-resort surface independent of the auth layout and loaders.
  return (
    <div className="relative flex h-full min-h-0 overflow-x-hidden overflow-y-auto bg-background p-6 pb-safe-or-6">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 overflow-hidden"
      >
        <div className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--primary)/0.06)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--primary)/0.06)_1px,transparent_1px)] bg-[size:3rem_3rem]" />
        <div className="absolute inset-0 bg-gradient-to-r from-[#FFC8B0]/20 via-[#A6DEFF]/15 to-[#FFE7A2]/20 blur-3xl" />
        <div className="absolute -top-40 -left-40 h-96 w-96 rounded-full bg-[#FFC8B0]/15 blur-3xl" />
        <div className="absolute top-1/2 left-1/2 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#A6DEFF]/10 blur-3xl" />
        <div className="absolute -right-40 -bottom-40 h-96 w-96 rounded-full bg-[#FFE7A2]/15 blur-3xl" />
      </div>
      <Button
        showTooltip
        type="button"
        variant="outline"
        size="icon-sm"
        onClick={() => {
          setTheme(theme === "dark" ? "light" : "dark");
        }}
        className="fixed top-safe-offset-6 right-safe-offset-6 z-50 border-border bg-card text-foreground hover:bg-card-hover"
        aria-label={t(($) => {
          return $.auth.toggleTheme;
        })}
        aria-pressed={theme === "dark"}
      >
        {theme === "dark" ? (
          <Sun size={16} aria-hidden="true" />
        ) : (
          <Moon size={16} aria-hidden="true" />
        )}
      </Button>
      <span
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        role="status"
      >
        {t(($) => {
          return theme === "dark"
            ? $.auth.theme.darkEnabled
            : $.auth.theme.lightEnabled;
        })}
      </span>
      <a
        href="/"
        aria-label={t(
          ($) => {
            return $.auth.homeLink;
          },
          { brandName: BRAND_PRESENTATION.brandName },
        )}
        className="absolute top-6 left-6 flex items-center gap-2 hover:opacity-75 focus-visible:opacity-75 focus-visible:outline-none"
      >
        <ProductBrandMark size="compact" />
      </a>
      <main className="relative z-10 m-auto flex w-full min-w-0 justify-center py-14 sm:py-16">
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
                href={`mailto:${contactEmail}`}
                className="text-brand-text underline underline-offset-4"
              >
                {t(($) => {
                  return $.shared.errorBoundary.contactSupport;
                })}
              </a>
              <br />
              {t(($) => {
                return $.shared.errorBoundary.help;
              })}
            </p>
          </Card>
        </div>
      </main>
    </div>
  );
}
