import { context } from "./chat-message-experience-test-helpers.ts";

const CONNECTOR_POPOVER_WIDTH = 288;
const CONNECTOR_ROW_HEIGHT = 40;
const CONNECTOR_LIST_MAX_HEIGHT = 256;
const CONNECTOR_POPOVER_CHROME_HEIGHT = 88;
const POPOVER_SIDE_OFFSET = 4;

interface RectInput {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

interface ConnectorPopoverLayoutOptions {
  readonly trigger: RectInput;
  readonly viewport: {
    readonly height: number;
    readonly width: number;
  };
}

interface ConnectorPopoverLayout {
  readonly notifyResize: () => void;
}

function domRect({ height, width, x, y }: RectInput): DOMRect {
  return {
    bottom: y + height,
    height,
    left: x,
    right: x + width,
    toJSON: () => {
      return {};
    },
    top: y,
    width,
    x,
    y,
  } as DOMRect;
}

function replaceProperty(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor,
): void {
  const original = Object.getOwnPropertyDescriptor(target, property);
  Object.defineProperty(target, property, {
    configurable: true,
    ...descriptor,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (original) {
        Object.defineProperty(target, property, original);
        return;
      }
      Reflect.deleteProperty(target, property);
    },
    { once: true },
  );
}

function connectorPopup(element: HTMLElement): HTMLElement | null {
  if (
    element.getAttribute("role") === "dialog" &&
    element.getAttribute("aria-label") === "Connectors"
  ) {
    return element;
  }
  return null;
}

function connectorPositionerPopup(element: HTMLElement): HTMLElement | null {
  if (element.getAttribute("role") !== "presentation") {
    return null;
  }
  for (const child of element.children) {
    if (child instanceof HTMLElement && connectorPopup(child)) {
      return child;
    }
  }
  return null;
}

function builtinConnectorList(element: HTMLElement): boolean {
  return (
    element.getAttribute("role") === "list" &&
    element.getAttribute("aria-label") === "Connectors"
  );
}

function connectorRowCount(popup: HTMLElement): number {
  return popup.querySelectorAll('[role="listitem"]').length;
}

function connectorListHeight(popup: HTMLElement): number {
  const fixedHeight = requestedPopupHeight(popup);
  if (fixedHeight !== null) {
    return Math.min(
      CONNECTOR_LIST_MAX_HEIGHT,
      fixedHeight - CONNECTOR_POPOVER_CHROME_HEIGHT,
    );
  }
  return Math.min(
    connectorRowCount(popup) * CONNECTOR_ROW_HEIGHT,
    CONNECTOR_LIST_MAX_HEIGHT,
  );
}

function requestedPopupHeight(popup: HTMLElement): number | null {
  const height = popup.style.height;
  return height.endsWith("rem") ? Number.parseFloat(height) * 16 : null;
}

function connectorPopupHeight(
  popup: HTMLElement,
  viewportHeight: number,
): number {
  const fixedHeight = requestedPopupHeight(popup);
  if (fixedHeight !== null) {
    return Math.min(fixedHeight, viewportHeight);
  }
  return CONNECTOR_POPOVER_CHROME_HEIGHT + connectorListHeight(popup);
}

function connectorPopupRect(
  popup: HTMLElement,
  options: ConnectorPopoverLayoutOptions,
): DOMRect {
  const { trigger } = options;
  const height = connectorPopupHeight(popup, options.viewport.height);
  switch (popup.dataset.side) {
    case "bottom": {
      return domRect({
        x: trigger.x,
        y: trigger.y + trigger.height + POPOVER_SIDE_OFFSET,
        width: CONNECTOR_POPOVER_WIDTH,
        height,
      });
    }
    case "left": {
      return domRect({
        x: trigger.x - CONNECTOR_POPOVER_WIDTH - POPOVER_SIDE_OFFSET,
        y: trigger.y,
        width: CONNECTOR_POPOVER_WIDTH,
        height,
      });
    }
    case "right": {
      return domRect({
        x: trigger.x + trigger.width + POPOVER_SIDE_OFFSET,
        y: trigger.y,
        width: CONNECTOR_POPOVER_WIDTH,
        height,
      });
    }
    case "top":
    default: {
      return domRect({
        x: trigger.x,
        y: trigger.y - height - POPOVER_SIDE_OFFSET,
        width: CONNECTOR_POPOVER_WIDTH,
        height,
      });
    }
  }
}

export function mockConnectorPopoverLayout(
  options: ConnectorPopoverLayoutOptions,
): ConnectorPopoverLayout {
  const observers = new Set<TestResizeObserver>();
  const originalBoundingClientRect =
    HTMLElement.prototype.getBoundingClientRect;
  const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );
  const offsetWidthDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetWidth",
  );
  const clientHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  );
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );

  class TestResizeObserver implements ResizeObserver {
    private observed = new Set<Element>();

    constructor(private readonly callback: ResizeObserverCallback) {
      observers.add(this);
    }

    observe(target: Element): void {
      this.observed.add(target);
    }

    unobserve(target: Element): void {
      this.observed.delete(target);
    }

    disconnect(): void {
      this.observed = new Set();
      observers.delete(this);
    }

    notify(): void {
      const entries = Array.from(this.observed).map((target) => {
        return {
          target,
          contentRect: target.getBoundingClientRect(),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        } as unknown as ResizeObserverEntry;
      });
      if (entries.length > 0) {
        this.callback(entries, this);
      }
    }
  }

  replaceProperty(globalThis, "ResizeObserver", {
    value: TestResizeObserver,
    writable: true,
  });
  replaceProperty(document.documentElement, "clientHeight", {
    get: () => {
      return options.viewport.height;
    },
  });
  replaceProperty(document.documentElement, "clientWidth", {
    get: () => {
      return options.viewport.width;
    },
  });
  replaceProperty(HTMLElement.prototype, "offsetHeight", {
    get(this: HTMLElement): number {
      const popup =
        connectorPopup(this) ?? connectorPositionerPopup(this) ?? null;
      if (popup) {
        return connectorPopupHeight(popup, options.viewport.height);
      }
      if (builtinConnectorList(this)) {
        const parentPopup = this.closest<HTMLElement>('[role="dialog"]');
        return parentPopup ? connectorListHeight(parentPopup) : 0;
      }
      return offsetHeightDescriptor?.get?.call(this) ?? 0;
    },
  });
  replaceProperty(HTMLElement.prototype, "offsetWidth", {
    get(this: HTMLElement): number {
      const popup = connectorPopup(this) ?? connectorPositionerPopup(this);
      if (popup !== null || builtinConnectorList(this)) {
        return CONNECTOR_POPOVER_WIDTH;
      }
      return offsetWidthDescriptor?.get?.call(this) ?? 0;
    },
  });
  replaceProperty(HTMLElement.prototype, "clientHeight", {
    get(this: HTMLElement): number {
      if (builtinConnectorList(this)) {
        const parentPopup = this.closest<HTMLElement>('[role="dialog"]');
        return parentPopup ? connectorListHeight(parentPopup) : 0;
      }
      return clientHeightDescriptor?.get?.call(this) ?? 0;
    },
  });
  replaceProperty(HTMLElement.prototype, "scrollHeight", {
    get(this: HTMLElement): number {
      if (builtinConnectorList(this)) {
        return Math.max(
          this.clientHeight,
          this.querySelectorAll('[role="listitem"]').length *
            CONNECTOR_ROW_HEIGHT,
        );
      }
      return scrollHeightDescriptor?.get?.call(this) ?? 0;
    },
  });
  replaceProperty(HTMLElement.prototype, "getBoundingClientRect", {
    value(this: HTMLElement): DOMRect {
      if (
        this.tagName === "BUTTON" &&
        this.getAttribute("aria-label") === "Connectors"
      ) {
        return domRect(options.trigger);
      }
      const popup = connectorPopup(this) ?? connectorPositionerPopup(this);
      if (popup) {
        return connectorPopupRect(popup, options);
      }
      if (builtinConnectorList(this)) {
        const parentPopup = this.closest<HTMLElement>('[role="dialog"]');
        if (parentPopup) {
          const popupRect = connectorPopupRect(parentPopup, options);
          return domRect({
            x: popupRect.x,
            y: popupRect.y + 40,
            width: popupRect.width,
            height: connectorListHeight(parentPopup),
          });
        }
      }
      return originalBoundingClientRect.call(this);
    },
  });

  return {
    notifyResize: () => {
      for (const observer of observers) {
        observer.notify();
      }
    },
  };
}
