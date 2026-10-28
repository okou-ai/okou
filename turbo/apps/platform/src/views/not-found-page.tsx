import { buttonVariants } from "@okouai/ui";
import { useTranslation } from "react-i18next";

import { ROUTES } from "../signals/route-paths.ts";
import { OkouLogomark } from "./components/okou-logomark.tsx";
import { Link } from "./router/link.tsx";

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
