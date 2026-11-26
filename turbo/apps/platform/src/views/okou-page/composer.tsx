import type { ComponentProps } from "react";
import { ChatComposer as CoreChatComposer } from "./chat-composer.tsx";
import { ComposerCapabilityTray } from "./composer-capability-tray.tsx";

type ChatComposerProps = Omit<
  ComponentProps<typeof CoreChatComposer>,
  "discovery"
>;

export function ChatComposer(props: ChatComposerProps) {
  return (
    <CoreChatComposer
      {...props}
      discovery={
        props.layout !== "home" ? (
          <ComposerCapabilityTray signals={props.signals} />
        ) : null
      }
    />
  );
}
