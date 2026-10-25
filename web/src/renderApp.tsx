import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { appRoutes } from "./App.tsx";
import { normalizePathname, routeById } from "./routes/routeManifest.ts";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("missing web root");

const normalizedPathname = normalizePathname(window.location.pathname);
const InitialDocsRoute = window.location.pathname.startsWith("/docs")
  ? (await import("./routes/docs/DocsRoute.tsx")).default
  : undefined;
const InitialLegalRoute = [routeById("terms").path, routeById("privacy").path].includes(normalizedPathname)
  ? (await import("./routes/legal/LegalRoute.tsx")).default
  : undefined;
const InitialGetRoute = normalizedPathname === routeById("get").path
  ? (await import("./routes/get/GetRoute.tsx")).default
  : undefined;
const InitialTokenListRoute = normalizedPathname === routeById("tokens").path
  ? (await import("./routes/tokens/TokenListPage.tsx")).default
  : undefined;
const router = createBrowserRouter(appRoutes({
  ...InitialDocsRoute === undefined ? {} : { docsRoute: <InitialDocsRoute /> },
  ...InitialLegalRoute === undefined ? {} : { legalPage: <InitialLegalRoute /> },
  ...InitialGetRoute === undefined ? {} : { getPage: <InitialGetRoute /> },
  ...InitialTokenListRoute === undefined ? {} : { tokenListPage: <InitialTokenListRoute /> },
}));
const application = <StrictMode><RouterProvider router={router} /></StrictMode>;

if (root.hasChildNodes() && root.dataset.prerenderPath === normalizedPathname) {
  hydrateRoot(root, application);
} else {
  root.replaceChildren();
  for (const element of document.head.querySelectorAll("[data-pcash-route-metadata]")) element.remove();
  document.title = "PCASH";
  createRoot(root).render(application);
}
