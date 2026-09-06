import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installStubs } from "./lib/config";
import "./styles.css";

// Stubs are installed BEFORE React mounts, so the very first request (the boot
// refresh) already goes through the mock transport when VITE_USE_MOCKS is on.
installStubs();

const root = document.getElementById("root");
if (!root) throw new Error("TaskFlow: #root is missing from index.html.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
