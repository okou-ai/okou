import { Dialog, DialogContent, DialogTitle } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { HALLOWEEN_COPY as copy } from "../../signals/halloween/halloween-content.ts";
import {
  closeHalloweenModal$,
  halloweenModalOpen$,
  openHalloweenModal$,
} from "../../signals/halloween/halloween.ts";
import { mountHalloweenModal$ } from "../../signals/halloween/halloween-modal.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { HalloweenBubbles, HalloweenEntry } from "./halloween-home.tsx";
import { HalloweenPage } from "./halloween-page.tsx";

export function HalloweenHomeActivity() {
  const open = useGet(halloweenModalOpen$);
  const show = useSet(openHalloweenModal$);
  const close = useSet(closeHalloweenModal$);
  const mount = useSet(mountHalloweenModal$);
  const signal = useGet(pageSignal$);
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          show();
        } else {
          detach(close(signal), Reason.DomCallback);
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
        <HalloweenPage embedded />
      </DialogContent>
    </Dialog>
  );
}
