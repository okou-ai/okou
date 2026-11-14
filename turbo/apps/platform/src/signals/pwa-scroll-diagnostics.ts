import { command, computed, state } from "ccstate";
import { i18n } from "../i18n/index.ts";
import { getBuildCommitSha } from "../lib/build-info.ts";
import { now } from "../lib/time.ts";
import {
  isPwaScrollDiagnosticsPreview,
  PWA_SCROLL_DIAGNOSTICS_EVENT,
  PWA_SCROLL_RECORDING_ATTRIBUTE,
  PwaScrollSourceEvent,
} from "../lib/pwa-scroll-diagnostics.ts";
import { onRef } from "./utils.ts";

const CAPACITY = 240;
const PAGE_SIZE = 6;
type Value = string | number | boolean | null;
type RecordEntry = Readonly<Record<string, Value>>;
interface InputProvenance {
  kind: string;
  at: number;
  trusted: boolean;
}
interface Readout {
  page: number;
  pages: number;
  summary: string;
  json: string;
}

function checkpointGeometry(container: HTMLElement) {
  const rect = container.getBoundingClientRect();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    // Read only synthetic prefixes; never retain message text or event IDs.
    const digits = /^\s*Checkpoint (\d{3})\b/u.exec(
      node.textContent ?? "",
    )?.[1];
    const parent = node.parentElement;
    if (digits && parent) {
      const target = parent.getBoundingClientRect();
      if (target.bottom > rect.top && target.top < rect.bottom) {
        return { checkpoint: digits, offset: target.top - rect.top };
      }
    }
    node = walker.nextNode();
  }
  return { checkpoint: null, offset: null };
}

function viewportGeometry(input: InputProvenance | null): RecordEntry {
  const viewport = window.visualViewport;
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    screenWidth: screen.width,
    screenHeight: screen.height,
    angle: screen.orientation?.angle ?? null,
    visualWidth: viewport?.width ?? null,
    visualHeight: viewport?.height ?? null,
    visualTop: viewport?.offsetTop ?? null,
    visualLeft: viewport?.offsetLeft ?? null,
    scale: viewport?.scale ?? null,
    hidden: document.hidden,
    input: input?.kind ?? null,
    inputAge: input ? Math.round(performance.now() - input.at) : null,
    inputTrusted: input?.trusted ?? null,
  };
}

function documentGeometry(): RecordEntry {
  const html = document.documentElement;
  const body = document.body;
  const htmlStyle = getComputedStyle(html);
  const bodyStyle = getComputedStyle(body);
  return {
    htmlOverflowHidden: htmlStyle.overflowY === "hidden",
    bodyOverflowHidden: bodyStyle.overflowY === "hidden",
    htmlOverflowClip: htmlStyle.overflowY === "clip",
    bodyOverflowClip: bodyStyle.overflowY === "clip",
    htmlFixed: htmlStyle.position === "fixed",
    bodyFixed: bodyStyle.position === "fixed",
    bodyPaddingRight: Number.parseFloat(bodyStyle.paddingRight),
    bodyScrollLockAttribute: Object.hasOwn(body.dataset, "scrollLocked"),
    htmlInlineOverflowHidden: html.style.overflow === "hidden",
    bodyInlineOverflowHidden: body.style.overflow === "hidden",
    windowScrollY: window.scrollY,
    htmlClientHeight: html.clientHeight,
    htmlTop: html.scrollTop,
    htmlHeight: html.scrollHeight,
    bodyTop: body.scrollTop,
    bodyRectTop: body.getBoundingClientRect().top,
    bodyRectHeight: body.getBoundingClientRect().height,
  };
}

function compactEntry(entry: RecordEntry): string {
  const prefix = `${entry.seq} @${entry.ms} ${entry.kind}`;
  if (entry.kind === "scroller") {
    return `${prefix} #${entry.id} ${entry.cause}\ntop=${entry.top} h=${entry.height}/${entry.client} gap=${entry.bottomGap} cp=${entry.checkpoint} off=${entry.offset} hidden=#${entry.hiddenAncestor}`;
  }
  if (entry.channel === "source") {
    return `${prefix} #${entry.id} req=${entry.requestedTop} target=${entry.targetTop} rev=${entry.revision} held=${entry.held}`;
  }
  if (entry.channel === "focus") {
    return `${prefix} #${entry.id} trusted=${entry.trusted}`;
  }
  return `${prefix} ${entry.width ?? ""}x${entry.height ?? ""} vv=${entry.visualWidth ?? ""}x${entry.visualHeight ?? ""} lock=${entry.htmlOverflowHidden ?? ""}/${entry.bodyOverflowHidden ?? ""} input=${entry.input ?? ""} age=${entry.inputAge ?? ""} trusted=${entry.trusted ?? ""}`;
}

/** One instance per real onRef lifetime, never constructed during render. */
class PreviewScrollRecorder {
  recording = false;
  input: InputProvenance | null = null;
  private ring: RecordEntry[] = [];
  private next = 0;
  private total = 0;
  private sequence = 0;
  private run = 0;
  private startedAt = 0;
  private marks = 0;
  private identity = 0;
  private identities = new WeakMap<HTMLElement, number>();

  id(element: HTMLElement): number {
    let value = this.identities.get(element);
    if (value === undefined) {
      value = ++this.identity;
      this.identities.set(element, value);
    }
    return value;
  }

  append(data: RecordEntry): void {
    if (!this.recording) {
      return;
    }
    this.ring[this.next] = {
      seq: ++this.sequence,
      ms: Math.round(performance.now()),
      ...data,
    };
    this.next = (this.next + 1) % CAPACITY;
    this.total++;
  }

  private scroller(
    container: HTMLElement,
    cause: string,
    event?: Event,
  ): RecordEntry {
    const rect = container.getBoundingClientRect();
    let hiddenAncestor: number | null = null;
    for (
      let ancestor: HTMLElement | null = container;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      if (getComputedStyle(ancestor).display === "none") {
        hiddenAncestor = this.id(ancestor);
        break;
      }
    }
    return {
      channel: "geometry",
      kind: "scroller",
      cause,
      id: this.id(container),
      eventTarget: event?.target === container,
      connected: container.isConnected,
      top: container.scrollTop,
      height: container.scrollHeight,
      client: container.clientHeight,
      bottomGap:
        container.scrollHeight - container.clientHeight - container.scrollTop,
      rectTop: rect.top,
      rectHeight: rect.height,
      rectWidth: rect.width,
      clientWidth: container.clientWidth,
      hiddenAncestor,
      anchorAuto: getComputedStyle(container).overflowAnchor === "auto",
      ...checkpointGeometry(container),
    };
  }

  snapshot(kind: string, event?: Event): void {
    if (!this.recording) {
      return;
    }
    this.append({
      channel: "geometry",
      kind,
      trusted: event?.isTrusted ?? null,
      ...viewportGeometry(this.input),
      ...documentGeometry(),
      active:
        document.activeElement instanceof HTMLElement
          ? this.id(document.activeElement)
          : null,
    });
    for (const container of document.querySelectorAll<HTMLElement>(
      "[data-scroll-container]",
    )) {
      this.append(this.scroller(container, kind, event));
    }
  }

  start(): void {
    if (this.recording) {
      return;
    }
    this.ring = [];
    this.next = 0;
    this.total = 0;
    this.sequence = 0;
    this.marks = 0;
    this.input = null;
    this.run++;
    this.startedAt = now();
    this.recording = true;
    document.documentElement.setAttribute(PWA_SCROLL_RECORDING_ATTRIBUTE, "");
    this.append({ channel: "lifecycle", kind: "start", epoch: this.startedAt });
    this.snapshot("start");
  }

  mark(): void {
    this.append({ channel: "marker", kind: "mark", mark: ++this.marks });
    this.snapshot("mark");
  }

  stop(): void {
    this.snapshot("stop");
    this.recording = false;
    document.documentElement.removeAttribute(PWA_SCROLL_RECORDING_ATTRIBUTE);
  }

  dispose(): void {
    this.recording = false;
    this.ring = [];
    document.documentElement.removeAttribute(PWA_SCROLL_RECORDING_ATTRIBUTE);
  }

  read(requestedPage: number): Readout | null {
    if (this.recording) {
      return null;
    }
    const entries =
      this.total > CAPACITY
        ? [...this.ring.slice(this.next), ...this.ring.slice(0, this.next)]
        : this.ring;
    const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
    const page = Math.max(0, Math.min(requestedPage, pages - 1));
    const slice = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const metadata = {
      schema: 1,
      run: this.run,
      epoch: this.startedAt,
      sha: getBuildCommitSha(),
      standalone: "standalone" in navigator && navigator.standalone === true,
      displayStandalone: matchMedia("(display-mode: standalone)").matches,
      overflowAnchor: CSS.supports("overflow-anchor", "auto"),
      total: this.total,
      retained: entries.length,
      dropped: Math.max(0, this.total - CAPACITY),
    };
    return {
      page,
      pages,
      summary: i18n.t(
        ($) => {
          return $.pwaScrollDiagnostics.summary;
        },
        {
          sha: metadata.sha ?? "missing",
          state: this.run === 0 ? "idle" : "stopped",
          standalone: metadata.standalone,
          display: metadata.displayStandalone,
          anchorSupport: metadata.overflowAnchor,
          run: this.run,
          retained: metadata.retained,
          total: metadata.total,
          dropped: metadata.dropped,
          entries: slice.map(compactEntry).join("\n"),
        },
      ),
      json: JSON.stringify({ ...metadata, entries }, null, 2),
    };
  }
}

function attachRecorder(
  recorder: PreviewScrollRecorder,
  signal: AbortSignal,
): void {
  for (const kind of [
    "pointerdown",
    "touchstart",
    "touchmove",
    "wheel",
    "keydown",
  ]) {
    document.addEventListener(
      kind,
      (event) => {
        if (!recorder.recording) {
          return;
        }
        recorder.input = {
          kind,
          at: performance.now(),
          trusted: event.isTrusted,
        };
        recorder.append({ channel: "input", kind, trusted: event.isTrusted });
      },
      { signal, capture: true, passive: true },
    );
  }
  document.addEventListener(
    "scroll",
    (event) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.matches("[data-scroll-container]")
      ) {
        recorder.snapshot("scroll", event);
      }
    },
    { signal, capture: true, passive: true },
  );
  for (const kind of ["resize", "orientationchange", "pagehide", "pageshow"]) {
    window.addEventListener(
      kind,
      (event) => {
        recorder.snapshot(kind, event);
      },
      { signal, passive: true },
    );
  }
  for (const kind of ["focusin", "focusout"]) {
    document.addEventListener(
      kind,
      (event) => {
        if (!recorder.recording) {
          return;
        }
        recorder.append({
          channel: "focus",
          kind,
          id:
            event.target instanceof HTMLElement
              ? recorder.id(event.target)
              : null,
          trusted: event.isTrusted,
        });
        recorder.snapshot(kind, event);
      },
      { signal, capture: true },
    );
  }
  document.addEventListener(
    "visibilitychange",
    (event) => {
      recorder.snapshot("visibility", event);
    },
    { signal },
  );
  for (const kind of ["resize", "scroll"]) {
    window.visualViewport?.addEventListener(
      kind,
      (event) => {
        recorder.snapshot(`visual-${kind}`, event);
      },
      { signal, passive: true },
    );
  }
  document.addEventListener(
    PWA_SCROLL_DIAGNOSTICS_EVENT,
    (event) => {
      if (!recorder.recording || !(event instanceof PwaScrollSourceEvent)) {
        return;
      }
      const detail = event.detail;
      recorder.append({
        channel: "source",
        kind: detail.kind,
        id: detail.element ? recorder.id(detail.element) : null,
        requestedTop: detail.requestedTop ?? null,
        targetTop: detail.targetTop ?? null,
        revision: detail.revision ?? null,
        offset: detail.offset ?? null,
        held: detail.held ?? null,
        measured: detail.measured ?? null,
        behavior: detail.behavior ?? null,
      });
    },
    { signal },
  );
}

const recorder$ = state<PreviewScrollRecorder | null>(null);
const status$ = state("Idle");
const output$ = state("");
const summary$ = state("");
const page$ = state(0);
const pageCount$ = state(0);
export const pwaScrollDiagnosticsStatus$ = computed((get) => {
  return get(status$);
});
export const pwaScrollDiagnosticsOutput$ = computed((get) => {
  return get(output$);
});
export const pwaScrollDiagnosticsSummary$ = computed((get) => {
  return get(summary$);
});
export const pwaScrollDiagnosticsPage$ = computed((get) => {
  return get(page$);
});
export const pwaScrollDiagnosticsPageCount$ = computed((get) => {
  return get(pageCount$);
});

export const pwaScrollDiagnosticsOnRef$ = onRef(
  command(({ set }, _element: HTMLElement, signal: AbortSignal) => {
    if (!isPwaScrollDiagnosticsPreview()) {
      return;
    }
    const recorder = new PreviewScrollRecorder();
    set(recorder$, recorder);
    attachRecorder(recorder, signal);
    signal.addEventListener(
      "abort",
      () => {
        recorder.dispose();
        set(recorder$, null);
        set(status$, "Idle");
        set(output$, "");
        set(summary$, "");
        set(pageCount$, 0);
      },
      { once: true },
    );
  }),
);
export const startPwaScrollDiagnostics$ = command(({ get, set }) => {
  const recorder = get(recorder$);
  if (!recorder || recorder.recording) {
    return;
  }
  recorder.start();
  set(output$, "");
  set(pageCount$, 0);
  set(status$, "Recording");
});
export const markPwaScrollDiagnostics$ = command(({ get }) => {
  get(recorder$)?.mark();
});
export const readPwaScrollDiagnostics$ = command(
  ({ get, set }, delta: number) => {
    const readout = get(recorder$)?.read(get(page$) + delta);
    if (!readout) {
      return;
    }
    set(page$, readout.page);
    set(pageCount$, readout.pages);
    set(output$, readout.json);
    set(summary$, readout.summary);
  },
);
export const stopPwaScrollDiagnostics$ = command(({ get, set }) => {
  get(recorder$)?.stop();
  set(status$, "Stopped");
  set(page$, 0);
  set(readPwaScrollDiagnostics$, 0);
});
