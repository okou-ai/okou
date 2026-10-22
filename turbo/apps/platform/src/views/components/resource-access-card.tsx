import type { ReactNode } from "react";
import { Card } from "@okouai/ui";
import { LockKeyhole } from "lucide-react";
import { useTranslation } from "react-i18next";

/** Shared recovery surface for unavailable artifacts and published websites. */
export function ResourceAccessCard({
  title,
  description,
  help,
  email,
  error,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly help?: string;
  readonly email?: string;
  readonly error?: string;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-full items-center justify-center bg-background px-5 py-10 sm:px-8">
      <Card className="w-full max-w-[480px] rounded-3xl">
        <div className="px-6 pb-8 pt-9 text-center sm:px-9 sm:pt-10">
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <LockKeyhole size={24} strokeWidth={1.5} aria-hidden />
          </div>
          <h2 className="mt-6 text-2xl font-semibold leading-8 tracking-tight text-foreground">
            {title}
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {description}
            {help && (
              <>
                <br />
                {help}
              </>
            )}
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
            {children}
          </div>
          {error && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        {email && (
          <div className="border-t border-border/70 px-6 py-4 text-center text-xs leading-5 text-muted-foreground">
            <p className="break-words">
              {t(
                ($) => {
                  return $.artifacts.access.signedInAs;
                },
                { email },
              )}
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
