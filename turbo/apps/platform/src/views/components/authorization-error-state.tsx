import { ProductBrandMarkLink } from "../okou-page/directed-shared.tsx";
import { BrandedErrorPage } from "./branded-error-page.tsx";

export function formatTime(value: string, locale: string): string {
  return new Date(value).toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function AuthorizationErrorState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <BrandedErrorPage
      title={title}
      description={description}
      brand={<ProductBrandMarkLink />}
    />
  );
}
