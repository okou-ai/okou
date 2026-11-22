import "i18next";
import type common from "./locales/en-US/common.json";

declare module "i18next" {
  interface CustomTypeOptions {
    enableSelector: true;
    defaultNS: "common";
    resources: {
      common: typeof common;
    };
    returnNull: false;
  }
}
