export interface TemplatePreviewRuntime {
  readonly imagePreloads: Map<string, HTMLImageElement>;
}

export function createTemplatePreviewRuntime(): TemplatePreviewRuntime {
  return {
    imagePreloads: new Map<string, HTMLImageElement>(),
  };
}
