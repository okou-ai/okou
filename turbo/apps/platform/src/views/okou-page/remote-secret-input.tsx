import type { ComponentProps } from "react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff } from "lucide-react";
import { IconButton, Input, cn } from "@okouai/ui";
import { remoteControlGuidedEnabled$ } from "../../signals/remote-control-setup.ts";
import {
  mountRemoteSecretInput$,
  remoteSecretVisibility$,
  toggleRemoteSecret$,
} from "../../signals/remote-secret-input.ts";

export function RemoteSecretInput(
  props: Omit<ComponentProps<typeof Input>, "type"> & { readonly id: string },
) {
  const { t } = useTranslation();
  const { id } = props;
  const guided = useGet(remoteControlGuidedEnabled$);
  const visible = useGet(remoteSecretVisibility$).has(id);
  const toggle = useSet(toggleRemoteSecret$);
  const mount = useSet(mountRemoteSecretInput$);
  if (!guided) {
    return <Input {...props} type="password" />;
  }
  return (
    <span className="relative block" ref={mount}>
      <Input
        {...props}
        id={id}
        type={visible ? "text" : "password"}
        className={cn("pr-10", props.className)}
      />
      <IconButton
        type="button"
        className="absolute inset-y-0 right-0.5 size-9 text-muted-foreground"
        aria-controls={id}
        aria-pressed={visible}
        aria-label={t(($) => {
          return visible
            ? $.remoteControlSetup.hideSecret
            : $.remoteControlSetup.showSecret;
        })}
        disabled={props.disabled}
        onClick={() => {
          toggle(id);
        }}
      >
        {visible ? (
          <Eye size={16} aria-hidden />
        ) : (
          <EyeOff size={16} aria-hidden />
        )}
      </IconButton>
    </span>
  );
}
