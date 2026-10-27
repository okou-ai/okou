import { Dialog, DialogContent, DialogTitle } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useHalloweenCopy } from "../../signals/halloween/halloween-content.ts";
import {
  closeHalloweenModal$,
  halloweenModalOpen$,
  openHalloweenModal$,
} from "../../signals/halloween/halloween.ts";
import { mountHalloweenModal$ } from "../../signals/halloween/halloween-modal.ts";
import { HalloweenBubbles, HalloweenEntry } from "./halloween-home.tsx";
import { HalloweenPage } from "./halloween-page.tsx";

export function HalloweenHomeActivity() {
  const copy = useHalloweenCopy();
  const open = useGet(halloweenModalOpen$);
  const show = useSet(openHalloweenModal$);
  const close = useSet(closeHalloweenModal$);
  const mount = useSet(mountHalloweenModal$);
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          show();
        } else {
          close();
        }
      }}
    >
      <HalloweenEntry />
      <HalloweenBubbles />
      <DialogContent
        ref={mount}
        maxWidth={1120}
        height={760}
        surface="transparent"
        contentClassName="block p-0"
        overlayClassName="backdrop-blur-sm"
        showCloseButton={false}
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">{copy.campaign}</DialogTitle>
        <HalloweenPage />
      </DialogContent>
    </Dialog>
  );
}
