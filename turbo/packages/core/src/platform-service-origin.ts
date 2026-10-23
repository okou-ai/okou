export type PlatformService = "api" | "www" | "app" | "platform";

const OKOU_PRODUCTION_DOMAIN = "okou.ai";
const OKOU_PREVIEW_DOMAIN = "omby.ai";
const PREVIEW_API_DOMAIN = "vm6.ai";
const PLATFORM_SERVICE_LABELS = ["platform", "app", "www", "api"] as const;
const OKOU_APP_WORKER_PREVIEW_HOST_PATTERN =
  /^((?:staging|pr-[0-9]+))-app-okou-app-preview\.vm0\.workers\.dev$/u;

function isDomainOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function okouAppWorkerPreviewJobRef(hostname: string): string | null {
  return (
    OKOU_APP_WORKER_PREVIEW_HOST_PATTERN.exec(hostname.toLowerCase())?.[1] ??
    null
  );
}

export function isOkouProductionHostname(hostname: string): boolean {
  return isDomainOrSubdomain(hostname.toLowerCase(), OKOU_PRODUCTION_DOMAIN);
}

export function rewritePlatformHostname(
  hostname: string,
  target: PlatformService,
): string {
  const labels = hostname.split(".");
  const serviceLabelIndex = labels.length - 3;
  if (serviceLabelIndex < 0) {
    return hostname;
  }

  const serviceLabel = labels[serviceLabelIndex];
  if (!serviceLabel) {
    return hostname;
  }

  if ((PLATFORM_SERVICE_LABELS as readonly string[]).includes(serviceLabel)) {
    labels[serviceLabelIndex] = target;
    return labels.join(".");
  }

  for (const label of PLATFORM_SERVICE_LABELS) {
    const suffix = `-${label}`;
    if (serviceLabel.endsWith(suffix)) {
      labels[serviceLabelIndex] =
        `${serviceLabel.slice(0, -label.length)}${target}`;
      return labels.join(".");
    }
  }

  return hostname;
}

function rewritePreviewServiceHostname(
  hostname: string,
  target: PlatformService,
): string {
  const workerPreviewJobRef = okouAppWorkerPreviewJobRef(hostname);
  if (workerPreviewJobRef) {
    if (target === "app") {
      return hostname;
    }
    if (target === "api") {
      return workerPreviewJobRef === "staging"
        ? `staging-api.${PREVIEW_API_DOMAIN}`
        : `okou-api-preview-${workerPreviewJobRef}.vm0.workers.dev`;
    }
    return `${workerPreviewJobRef}-${target}.${OKOU_PREVIEW_DOMAIN}`;
  }

  const rewrittenHostname = rewritePlatformHostname(hostname, target);
  const okouPreviewSuffix = `.${OKOU_PREVIEW_DOMAIN}`;
  if (target !== "api" || !rewrittenHostname.endsWith(okouPreviewSuffix)) {
    return rewrittenHostname;
  }
  return `${rewrittenHostname.slice(0, -okouPreviewSuffix.length)}.${PREVIEW_API_DOMAIN}`;
}

export function derivePlatformServiceOrigin(
  currentOrigin: string,
  target: PlatformService,
): string {
  const url = new URL(currentOrigin);
  url.hostname = isOkouProductionHostname(url.hostname)
    ? `${target}.${OKOU_PRODUCTION_DOMAIN}`
    : rewritePreviewServiceHostname(url.hostname, target);

  return url.origin;
}
