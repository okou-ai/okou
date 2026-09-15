import { isOkouProductionHostname } from "@okouai/core/platform-service-origin";
import { nowDate } from "./time.ts";

const GOOGLE_TAG_SCRIPT_URL =
  "https://www.googletagmanager.com/gtag/js?id=AW-18144854014";

type GoogleTag = (...args: unknown[]) => void;

type GoogleAdsWindow = Window & {
  dataLayer?: IArguments[];
  gtag?: GoogleTag;
};

function createGoogleTagArguments(
  args: readonly unknown[],
  callee: GoogleTag,
): IArguments {
  const indexedArgs: Record<number, unknown> = {};
  for (const [index, value] of args.entries()) {
    indexedArgs[index] = value;
  }
  return Object.assign(indexedArgs, {
    callee,
    length: args.length,
    [Symbol.iterator]: () => {
      return args[Symbol.iterator]();
    },
    [Symbol.toStringTag]: "Arguments",
  });
}

export function initGoogleAds(): void {
  if (!isOkouProductionHostname(window.location.hostname)) {
    return;
  }

  const googleAdsWindow: GoogleAdsWindow = window;
  const dataLayer = googleAdsWindow.dataLayer ?? [];
  googleAdsWindow.dataLayer = dataLayer;
  const gtag: GoogleTag = (...args) => {
    dataLayer.push(createGoogleTagArguments(args, gtag));
  };
  googleAdsWindow.gtag = gtag;
  gtag("js", nowDate());
  gtag("config", "AW-18144854014");
  gtag("config", "AW-18407336975");

  const script = document.createElement("script");
  script.async = true;
  script.src = GOOGLE_TAG_SCRIPT_URL;
  document.head.appendChild(script);
}
