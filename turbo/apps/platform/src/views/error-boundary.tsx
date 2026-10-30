import { Component, type ErrorInfo, type ReactNode } from "react";
import { Sentry } from "../lib/sentry.ts";
import { logger } from "../signals/log.ts";
import { DefaultErrorFallback } from "./default-error-boundary.tsx";

interface Props {
  children?: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

const L = logger("React");

// eslint-disable-next-line ccstate/no-react-class-component -- TODO(#11402): refactor existing class component.
export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    L.error("Uncaught error:", error, errorInfo);
    Sentry.captureException(error, {
      extra: { componentStack: errorInfo.componentStack },
    });
    this.setState({ errorInfo });
  }

  public render() {
    if (this.state.hasError) {
      if (this.state.error && this.state.errorInfo) {
        return this.props.fallback ?? <DefaultErrorFallback />;
      }

      // hasError is true but errorInfo not yet set (componentDidCatch hasn't fired).
      // Return null to avoid re-throwing by rendering children again.
      return null;
    }

    return this.props.children;
  }
}
