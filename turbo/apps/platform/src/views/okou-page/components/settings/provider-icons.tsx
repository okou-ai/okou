import type { ModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { cn } from "@okouai/ui";
import { platformOkouMarkDarkImg } from "../../../../lib/static-assets.ts";
import { settingsIconAssetUrl } from "./settings-icon-assets.ts";

const PROVIDER_ICONS: Readonly<Partial<Record<ModelProviderType, string>>> =
  Object.freeze({
    "claude-code-oauth-token": settingsIconAssetUrl("anthropic"),
    "anthropic-api-key": settingsIconAssetUrl("anthropic"),
    "openrouter-api-key": settingsIconAssetUrl("openrouter"),
    deepseek: settingsIconAssetUrl("deepseek"),
    "vercel-ai-gateway": settingsIconAssetUrl("vercel"),
    "openrouter-codex": settingsIconAssetUrl("openrouter"),
    "vercel-ai-gateway-codex": settingsIconAssetUrl("vercel"),
    "openai-api-key": settingsIconAssetUrl("openai"),
    "codex-oauth-token": settingsIconAssetUrl("openai"),
    "azure-foundry": settingsIconAssetUrl("azure"),
    "aws-bedrock": settingsIconAssetUrl("bedrock"),
    "built-in": platformOkouMarkDarkImg,
  });

const DARK_INVERT_PROVIDER_ICONS: Readonly<
  Partial<Record<ModelProviderType, true>>
> = Object.freeze({
  "openai-api-key": true,
  "codex-oauth-token": true,
  "built-in": true,
});

function providerIconNeedsDarkInvert(type: ModelProviderType): boolean {
  return DARK_INVERT_PROVIDER_ICONS[type] === true;
}

export function ProviderIcon({
  type,
  size = 28,
}: {
  type: ModelProviderType;
  size?: number;
}) {
  const icon = PROVIDER_ICONS[type];
  if (!icon) {
    return <DefaultIcon size={size} />;
  }
  return (
    <img
      src={icon}
      width={size}
      height={size}
      alt=""
      className={cn(
        "shrink-0",
        providerIconNeedsDarkInvert(type) && "dark:invert",
      )}
    />
  );
}

function DefaultIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="shrink-0"
    >
      <path
        d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8Zm-1-13h2v6h-2Zm0 8h2v2h-2Z"
        fill="currentColor"
        className="text-muted-foreground"
      />
    </svg>
  );
}
