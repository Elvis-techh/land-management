import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("No se encontró el elemento #root en index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    {/* The outermost net: if a render error escapes every panel-level boundary,
        this shows a full-page message with a reload instead of a blank tab. */}
    <ErrorBoundary variant="page">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
