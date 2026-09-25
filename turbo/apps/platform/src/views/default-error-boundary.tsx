import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { useTranslation } from "react-i18next";

export function DefaultErrorFallback() {
  const { t } = useTranslation();
  const contactEmail = BRAND_PRESENTATION.contactEmail;

  return (
    <div className="flex h-full items-center justify-center bg-white">
      <div className="flex flex-col items-center">
        <div className="mt-12">
          <div className="w-80 text-center text-base font-semibold text-gray-900">
            {t(($) => {
              return $.shared.errorBoundary.title;
            })}
          </div>

          <div className="mt-2 w-80 text-center text-sm text-gray-500">
            {t(($) => {
              return $.shared.errorBoundary.description;
            })}{" "}
            <a
              href={`mailto:${contactEmail}`}
              className="text-blue-500 hover:underline"
            >
              {t(($) => {
                return $.shared.errorBoundary.contactSupport;
              })}
            </a>
            <br />
            {t(($) => {
              return $.shared.errorBoundary.help;
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
