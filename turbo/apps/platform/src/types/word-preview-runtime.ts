export interface WordPreviewRuntime {
  readonly render: (data: ArrayBuffer) => Promise<string>;
}
