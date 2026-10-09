import { createLucideIcon, type IconNode } from "lucide-react";

// Lucide intentionally does not ship brand marks. Keep the product brand
// icons local while exposing the same props and rendering contract as Lucide.
const brandGithub: IconNode = [
  [
    "path",
    {
      d: "M9 19c-4.3 1.4 -4.3 -2.5 -6 -3m12 5v-3.5c0 -1 .1 -1.4 -.5 -2c2.8 -.3 5.5 -1.4 5.5 -6a4.6 4.6 0 0 0 -1.3 -3.2a4.2 4.2 0 0 0 -.1 -3.2s-1.1 -.3 -3.5 1.3a12.3 12.3 0 0 0 -6.2 0c-2.4 -1.6 -3.5 -1.3 -3.5 -1.3a4.2 4.2 0 0 0 -.1 3.2a4.6 4.6 0 0 0 -1.3 3.2c0 4.6 2.7 5.7 5.5 6c-.6 .6 -.6 1.2 -.5 2v3.5",
      key: "brand-github",
    },
  ],
];

const brandGoogleDrive: IconNode = [
  ["path", { d: "M12 10l-6 10l-3 -5l6 -10l3 5", key: "drive-left" }],
  ["path", { d: "M9 15h12l-3 5h-12", key: "drive-bottom" }],
  ["path", { d: "M15 15l-6 -10h6l6 10l-6 0", key: "drive-right" }],
];

const brandNotion: IconNode = [
  ["path", { d: "M11 17.5v-6.5h.5l4 6h.5v-6.5", key: "notion-letter" }],
  [
    "path",
    {
      d: "M19.077 20.071l-11.53 .887a1 1 0 0 1 -.876 -.397l-2.471 -3.294a1 1 0 0 1 -.2 -.6v-10.741a1 1 0 0 1 .923 -.997l11.389 -.876a2 2 0 0 1 1.262 .33l1.535 1.023a2 2 0 0 1 .891 1.664v12.004a1 1 0 0 1 -.923 .997",
      key: "notion-outline",
    },
  ],
  ["path", { d: "M4.5 5.5l2.5 2.5", key: "notion-fold" }],
  ["path", { d: "M20 7l-13 1v12.5", key: "notion-page" }],
];

const brandSlack: IconNode = [
  [
    "path",
    {
      d: "M12 12v-6a2 2 0 0 1 4 0v6m0 -2a2 2 0 1 1 2 2h-6",
      key: "slack-top",
    },
  ],
  [
    "path",
    {
      d: "M12 12h6a2 2 0 0 1 0 4h-6m2 0a2 2 0 1 1 -2 2v-6",
      key: "slack-right",
    },
  ],
  [
    "path",
    {
      d: "M12 12v6a2 2 0 0 1 -4 0v-6m0 2a2 2 0 1 1 -2 -2h6",
      key: "slack-bottom",
    },
  ],
  [
    "path",
    {
      d: "M12 12h-6a2 2 0 0 1 0 -4h6m-2 0a2 2 0 1 1 2 -2v6",
      key: "slack-left",
    },
  ],
];

const brandStripe: IconNode = [
  [
    "path",
    {
      d: "M11.453 8.056c0 -.623 .518 -.979 1.442 -.979c1.69 0 3.41 .343 4.605 .923l.5 -4c-.948 -.449 -2.82 -1 -5.5 -1c-1.895 0 -3.373 .087 -4.5 1c-1.172 .956 -2 2.33 -2 4c0 3.03 1.958 4.906 5 6c1.961 .69 3 .743 3 1.5c0 .735 -.851 1.5 -2 1.5c-1.423 0 -3.963 -.609 -5.5 -1.5l-.5 4c1.321 .734 3.474 1.5 6 1.5c2 0 3.957 -.468 5.084 -1.36c1.263 -.979 1.916 -2.268 1.916 -4.14c0 -3.096 -1.915 -4.547 -5 -5.637c-1.646 -.605 -2.544 -1.07 -2.544 -1.807l-.003 0",
      key: "brand-stripe",
    },
  ],
];

const brandTelegram: IconNode = [
  [
    "path",
    {
      d: "M15 10l-4 4l6 6l4 -16l-18 7l4 2l2 6l3 -4",
      key: "brand-telegram",
    },
  ],
];

export const BrandGithub = createLucideIcon("BrandGithub", brandGithub);
export const BrandGoogleDrive = createLucideIcon(
  "BrandGoogleDrive",
  brandGoogleDrive,
);
export const BrandNotion = createLucideIcon("BrandNotion", brandNotion);
export const BrandSlack = createLucideIcon("BrandSlack", brandSlack);
export const BrandStripe = createLucideIcon("BrandStripe", brandStripe);
export const BrandTelegram = createLucideIcon("BrandTelegram", brandTelegram);
