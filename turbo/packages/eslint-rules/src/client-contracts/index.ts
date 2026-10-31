import { preferClientDescriptors } from "./prefer-client-descriptors.ts";

export const clientContractsPlugin = {
  meta: { name: "client-contracts" },
  rules: {
    "prefer-client-descriptors": preferClientDescriptors,
  },
};
