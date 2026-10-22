import type { Root } from "hast";

export interface PdfRasterImage {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

export interface PdfAssets {
  readonly images: Map<string, PdfRasterImage>;
  readonly diagrams: Map<string, PdfRasterImage>;
}

export interface PdfWorkerRequest {
  readonly baseUrl: string;
  readonly tree: Root;
  readonly assets: PdfAssets;
  readonly regularFont: ArrayBuffer;
  readonly boldFont: ArrayBuffer;
}

export type PdfWorkerResponse =
  { readonly ok: true; readonly blob: Blob } | { readonly ok: false };

export interface PdfFormula {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
}

export type PdfMathRenderer = (source: string, display: boolean) => PdfFormula;
