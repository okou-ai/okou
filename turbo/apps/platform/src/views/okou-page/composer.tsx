import type { ComponentProps } from "react";
import { ChatComposer as CoreChatComposer } from "./chat-composer.tsx";
import { ComposerCapabilityTray } from "./composer-capability-tray.tsx";

type ChatComposerProps = Omit<
  ComponentProps<typeof CoreChatComposer>,
  "discovery"
> & {
  readonly discoveryInContent?: boolean;
};

export function ChatComposer({
  discoveryInContent,
  ...props
}: ChatComposerProps) {
  const contentHasDiscovery = discoveryInContent ?? props.layout === "home";
  return (
    <CoreChatComposer
      {...props}
      discovery={
        !contentHasDiscovery ? (
          <ComposerCapabilityTray signals={props.signals} />
        ) : null
      }
    />
  );
}
