declare module "react-katex" {
  import { ComponentType } from "react";
  interface KatexProps {
    math: string;
    renderError?: (error: Error) => JSX.Element;
    settings?: unknown;
    errorColor?: string;
  }
  export const InlineMath: ComponentType<KatexProps>;
  export const BlockMath: ComponentType<KatexProps>;
}
