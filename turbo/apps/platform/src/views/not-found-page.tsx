import { buttonVariants } from "@okouai/ui";
import { useTranslation } from "react-i18next";

import { ROUTES } from "../signals/route-paths.ts";
import { Link } from "./router/link.tsx";

// Keep the final four-petal logomark inline so the brand-orange ink follows
// `currentColor` across both themes without changing the existing 404 layout.
function OkouLogomark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 138 140">
      <path
        d="M603.905 167.457C589.107 72.5824 507.091 0 408.052 0H391.948C292.909 0 210.893 72.5824 196.095 167.457C84.6763 187.186 0 284.43 0 401.5C0 518.57 84.6763 615.814 196.095 635.543C210.893 730.418 292.909 803 391.948 803H408.052C507.091 803 589.107 730.418 603.905 635.543C715.324 615.814 800 518.57 800 401.5C800 284.43 715.324 187.186 603.905 167.457ZM533.446 462.622C489.972 557.593 394.947 607.255 321.248 573.551C247.549 539.798 223.031 435.446 266.554 340.475C310.028 245.504 405.054 195.842 478.752 229.546C552.451 263.299 576.969 367.651 533.446 462.622Z"
        transform="translate(0.26 0) scale(0.17173)"
        fill="currentColor"
      />
    </svg>
  );
}

// The picture is the number, the way www.okou.ai draws it: two digits and the
// brand's own four-petal O between them, so 404 and Okou read as one object.
// The wordmark the card used to carry is gone with the card — on this page the
// number is already the logotype, and showing both is the mark twice.
export function NotFoundPage() {
  const { t } = useTranslation();

  return (
    <main className="flex h-full min-h-0 flex-col items-center justify-center overflow-y-auto bg-background px-6 py-10 text-center">
      <p
        aria-hidden="true"
        className="flex items-center gap-2 text-[104px] font-bold leading-[0.8] tracking-[-0.05em] text-foreground sm:gap-3 sm:text-[152px] lg:text-[200px]"
      >
        <span>4</span>
        {/* Sized off the digits, not off the cap: 0.86 of the font size is
            where the mark's bowl sits against a lining figure. */}
        <OkouLogomark className="h-[90px] w-auto text-primary sm:h-[131px] lg:h-[172px]" />
        <span>4</span>
      </p>

      <h1 className="mt-8 text-2xl font-semibold tracking-[-0.02em] text-foreground sm:mt-11 sm:text-3xl">
        {t(($) => {
          return $.shared.notFound.title;
        })}
      </h1>
      <p className="mt-2.5 max-w-[46ch] text-base leading-6 text-muted-foreground">
        {t(($) => {
          return $.shared.notFound.description;
        })}
      </p>

      {/* Two destinations, not one apology. This surface replaces the whole
          app shell, so the buttons are the only navigation the page has. */}
      <div className="mt-6 flex flex-wrap justify-center gap-3 sm:mt-7">
        <Link pathname={ROUTES.home} className={buttonVariants({ size: "lg" })}>
          {t(($) => {
            return $.shared.notFound.action;
          })}
        </Link>
        <Link
          pathname={ROUTES.workflows}
          className={buttonVariants({ size: "lg", variant: "neutral" })}
        >
          {t(($) => {
            return $.shared.notFound.browse;
          })}
        </Link>
      </div>
    </main>
  );
}
