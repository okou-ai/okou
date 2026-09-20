import { Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";

import { ROUTES } from "../signals/route-paths.ts";
import { Link } from "./router/link.tsx";

// The same scalloped O the marketing 404 draws, at the proportions the
// wordmark draws it. It is inline rather than the published wordmark asset
// because the ink is the brand orange here, which only `currentColor` can
// carry across both themes.
function OkouScallopedMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 138 140">
      <path
        d="M137.9 69.622C137.9 60.7513 133.387 52.9503 126.538 48.3584C125.299 47.5235 124.686 45.9972 125.012 44.5362C126.929 36.2264 124.646 27.147 118.176 20.6766C111.901 14.4018 103.187 12.0798 95.0992 13.6713C93.612 13.9714 92.0988 13.28 91.29 11.9885C86.7764 4.78757 78.7666 0 69.622 0C60.4773 0 52.9503 4.51362 48.3584 11.3623C47.5235 12.6016 45.9972 13.2147 44.5361 12.8886C36.2264 10.971 27.147 13.2539 20.6766 19.7243C14.4018 25.999 12.0798 34.7132 13.6713 42.8012C13.9714 44.2883 13.28 45.8015 11.9885 46.6103C4.78757 51.124 0 59.1467 0 68.2783C0 77.4099 4.51362 84.95 11.3623 89.5419C12.6016 90.3768 13.2147 91.9031 12.8886 93.3642C10.971 101.674 13.2539 110.753 19.7243 117.224C25.999 123.498 34.7132 125.821 42.8011 124.229C44.2883 123.929 45.8015 124.62 46.6103 125.912C51.137 133.113 59.1467 137.9 68.2914 137.9C77.436 137.9 84.9631 133.387 89.555 126.538C90.3899 125.299 91.9161 124.686 93.3772 125.012C101.687 126.929 110.766 124.646 117.237 118.176C123.511 111.901 125.834 103.187 124.242 95.0992C123.942 93.612 124.633 92.0988 125.925 91.29C133.126 86.7633 137.913 78.7536 137.913 69.6089L137.9 69.622ZM63.3864 98.3344C58.9771 97.4473 54.9201 95.621 51.4109 93.0772C48.6323 91.0552 46.219 88.5896 44.2622 85.7719C41.7706 82.1975 40.0225 78.0622 39.2398 73.5877C38.9398 71.8658 38.7702 70.0916 38.7702 68.2783C38.7702 66.6216 38.9006 64.991 39.1615 63.3994C39.9051 58.7684 41.6793 54.4766 44.2622 50.7848C46.2059 47.9801 48.6193 45.5276 51.3718 43.5186C55.1419 40.7661 59.5642 38.8485 64.3648 38.0527C66.0215 37.7788 67.7043 37.6222 69.4393 37.6222C71.1743 37.6222 72.8702 37.7788 74.5269 38.0527C79.4189 38.8746 83.9195 40.8444 87.7417 43.6882C90.4681 45.7233 92.8554 48.2018 94.773 51.0196C97.4342 54.9201 99.2084 59.4598 99.8345 64.3648C100.004 65.6563 100.095 66.9608 100.095 68.2914C100.095 70.4308 99.8737 72.505 99.4562 74.5139C98.4909 79.1841 96.4558 83.4759 93.625 87.1025C91.5248 89.7898 88.994 92.1249 86.1241 93.9903C82.4193 96.4037 78.1665 98.0343 73.5877 98.6605C72.231 98.8431 70.8352 98.9475 69.4263 98.9475C67.3521 98.9475 65.3432 98.7388 63.3864 98.3474V98.3344Z"
        fill="currentColor"
      />
    </svg>
  );
}

// The picture is the number, the way www.okou.ai draws it: two digits and the
// brand's own scalloped O between them, so 404 and Okou read as one object.
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
        <OkouScallopedMark className="h-[90px] w-auto text-primary sm:h-[131px] lg:h-[172px]" />
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
        <Button asChild size="lg">
          <Link pathname={ROUTES.home}>
            {t(($) => {
              return $.shared.notFound.action;
            })}
          </Link>
        </Button>
        <Button asChild size="lg" variant="neutral">
          <Link pathname={ROUTES.workflows}>
            {t(($) => {
              return $.shared.notFound.browse;
            })}
          </Link>
        </Button>
      </div>
    </main>
  );
}
