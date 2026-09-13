import { Card, CardContent, CardDescription, CardHeader } from "@okouai/ui";
import { useSet } from "ccstate-react";
import type { ReactNode } from "react";

import { focusAuthHeadingRef$ } from "../../signals/auth-presentation.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";

const AUTH_CARD_TITLE_ID = "auth-card-title";
const AUTH_CARD_DESCRIPTION_ID = "auth-card-description";

interface AuthCardShellProps {
  readonly announcement?: ReactNode;
  readonly children: ReactNode;
  readonly description?: ReactNode;
  readonly focusKey: string;
  readonly title: ReactNode;
}

export function AuthCardShell({
  announcement,
  children,
  description,
  focusKey,
  title,
}: AuthCardShellProps) {
  const focusHeading = useSet(focusAuthHeadingRef$);

  return (
    <div className="w-[calc(100%+0.5rem)] max-w-[25rem] shrink-0 space-y-4">
      <Card
        aria-describedby={description ? AUTH_CARD_DESCRIPTION_ID : undefined}
        aria-labelledby={AUTH_CARD_TITLE_ID}
        className="relative w-full rounded-[12px] border-border p-0 shadow-none"
        data-testid="app-auth-card"
        role="region"
      >
        <div className="flex flex-col gap-8 px-10 py-8">
          <CardHeader className="items-center space-y-0 bg-transparent p-0 text-center">
            <span className="mb-5" data-testid="auth-card-brand-logo">
              <ProductBrandMark decorative size="compact" />
            </span>
            <div className="w-full space-y-1">
              <h1
                className="text-lg font-medium text-foreground outline-none"
                id={AUTH_CARD_TITLE_ID}
                key={focusKey}
                ref={focusHeading}
                tabIndex={-1}
              >
                {title}
              </h1>
              {description ? (
                <CardDescription
                  className="max-w-sm leading-5"
                  id={AUTH_CARD_DESCRIPTION_ID}
                >
                  {description}
                </CardDescription>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="p-0">{children}</CardContent>
        </div>
      </Card>
      <p
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        data-testid="auth-card-announcer"
      >
        {announcement}
      </p>
    </div>
  );
}
