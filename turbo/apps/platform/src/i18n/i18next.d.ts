import "i18next";
import type common from "./locales/en-US/common.json";
import type agents from "./locales/en-US/agents.json";
import type halloween from "./locales/en-US/halloween.json";

declare module "i18next" {
  interface CustomTypeOptions {
    enableSelector: true;
    defaultNS: "common";
    resources: {
      agents: typeof agents;
      common: typeof common;
      halloween: typeof halloween;
    };
    returnNull: false;
  }
}
