export interface BrandPresentation {
  readonly [key: string]: string;
  readonly assistantName: "Okou";
  readonly brandName: "Okou";
  readonly contactEmail: "contact@okou.ai";
  readonly supportEmail: "support@okou.ai";
}

export const BRAND_PRESENTATION: BrandPresentation = Object.freeze({
  assistantName: "Okou",
  brandName: "Okou",
  contactEmail: "contact@okou.ai",
  supportEmail: "support@okou.ai",
});
