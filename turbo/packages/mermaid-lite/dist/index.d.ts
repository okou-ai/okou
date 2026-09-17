export interface MermaidThemeVariables {
  readonly fontSize?: string;
  readonly background?: string;
  readonly primaryColor?: string;
  readonly primaryTextColor?: string;
  readonly primaryBorderColor?: string;
  readonly secondaryColor?: string;
  readonly tertiaryColor?: string;
  readonly lineColor?: string;
  readonly noteBkgColor?: string;
  readonly noteTextColor?: string;
}

export interface MermaidFlowchartOptions {
  readonly nodeSpacing?: number;
  readonly rankSpacing?: number;
  readonly padding?: number;
}

export interface MermaidLiteConfig {
  readonly startOnLoad?: boolean;
  readonly securityLevel?: "strict";
  readonly suppressErrorRendering?: boolean;
  readonly theme?: "base";
  readonly fontFamily?: string;
  readonly themeVariables?: MermaidThemeVariables;
  readonly flowchart?: MermaidFlowchartOptions;
}

export interface MermaidParseOptions {
  readonly suppressErrors?: boolean;
}

export interface MermaidParseResult {
  readonly diagramType: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface MermaidRenderResult {
  readonly svg: string;
  readonly bindFunctions?: (element: Element) => void;
  readonly diagramType?: string;
}

export interface MermaidLiteApi {
  initialize(config: MermaidLiteConfig): void;
  parse(
    text: string,
    options?: MermaidParseOptions,
  ): Promise<MermaidParseResult | false>;
  render(id: string, text: string): Promise<MermaidRenderResult>;
}

declare const mermaid: MermaidLiteApi;

export default mermaid;
