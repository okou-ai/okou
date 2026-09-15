import { Button, cn } from "@okouai/ui";
import { Moon, Sun } from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AuthBrandContext } from "../../signals/auth.ts";
import { setTheme$, theme$ } from "../../signals/theme.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import { isDesktopAuthFlow } from "../../lib/desktop-auth-flow.ts";

interface AuthShellProps {
  readonly authBrand: AuthBrandContext;
  readonly children: ReactNode;
}

export function AuthShell({ authBrand, children }: AuthShellProps) {
  const { t } = useTranslation();
  const theme = useGet(theme$);
  const setTheme = useSet(setTheme$);

  return (
    <div
      className="okou-app relative flex h-full min-h-0 overflow-x-hidden overflow-y-auto bg-background p-6 pb-[max(1.5rem,var(--sab))]"
      data-testid="app-auth-layout"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 overflow-hidden"
        data-testid="app-auth-background"
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
          const nextTheme = theme === "dark" ? "light" : "dark";
          setTheme(nextTheme);
        }}
        className={cn(
          "fixed z-50 border-border bg-card text-foreground hover:bg-card-hover",
          "right-[calc(1.5rem+var(--sar))] top-[calc(1.5rem+var(--sat))]",
        )}
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

      {!isDesktopAuthFlow() && (
        <a
          href={authBrand.homeUrl}
          aria-label={t(
            ($) => {
              return $.auth.homeLink;
            },
            { brandName: authBrand.brandName },
          )}
          className={cn(
            "absolute flex items-center gap-2 hover:opacity-75 focus-visible:opacity-75 focus-visible:outline-none",
            "left-6 top-6",
          )}
        >
          <ProductBrandMark size="compact" />
        </a>
      )}

      <main className="relative z-10 m-auto flex w-full min-w-0 justify-center py-14 sm:py-16">
        {children}
      </main>
    </div>
  );
}
