export interface TemplatePreviewRuntime {
  readonly imagePreloads: Map<string, HTMLImageElement>;
  readonly illustration: {
    readonly decoded: Set<string>;
    readonly pendingDecodes: Map<string, Promise<void>>;
    readonly preloads: Map<string, HTMLImageElement>;
  };
}

export function createTemplatePreviewRuntime(): TemplatePreviewRuntime {
  return {
    imagePreloads: new Map<string, HTMLImageElement>(),
    illustration: {
      decoded: new Set<string>(),
      pendingDecodes: new Map<string, Promise<void>>(),
      preloads: new Map<string, HTMLImageElement>(),
    },
  };
}
