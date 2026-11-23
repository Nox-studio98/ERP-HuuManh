import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/app.css";
import { App } from "./App";
import { startOfflineSync } from "./offline";

async function boot() {
  if (import.meta.env.DEV && localStorage.mock === "1") {
    const m = await import("./mock");
    m.installMock();
  }
  startOfflineSync();
  createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  }
}
boot();
