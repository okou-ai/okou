/** Happy DOM lacks native insertion. Actual undo is verified in browser QA. */
export function mockNativeTextInsertion(signal: AbortSignal): void {
  if (typeof document.execCommand === "function") {
    return;
  }
  const descriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: (command: string, _showUI?: boolean, text?: string) => {
      const input = document.activeElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      if (
        command !== "insertText" ||
        typeof text !== "string" ||
        !(input instanceof HTMLInputElement) ||
        !setter
      ) {
        throw new Error("Unsupported native text insertion fixture");
      }
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      setter.call(
        input,
        input.value.slice(0, start) + text + input.value.slice(end),
      );
      input.setSelectionRange(start + text.length, start + text.length);
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: text,
        }),
      );
      return true;
    },
  });
  signal.addEventListener(
    "abort",
    () => {
      if (descriptor) {
        Object.defineProperty(document, "execCommand", descriptor);
      } else {
        Reflect.deleteProperty(document, "execCommand");
      }
    },
    { once: true },
  );
}
