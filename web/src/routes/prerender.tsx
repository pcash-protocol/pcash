import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { appRoutes } from "../App.tsx";
import DocsRoute from "./docs/DocsRoute.tsx";
import GetRoute from "./get/GetRoute.tsx";
import LegalRoute from "./legal/LegalRoute.tsx";
import TokenListPage from "./tokens/TokenListPage.tsx";
import { clientRoutePrefixes, prerenderRoutes, routeManifest } from "./routeManifest.ts";

export interface PrerenderedPublicPage {
  pathname: string;
  title: string;
  description: string;
  html: string;
}

export function renderPublicPage(pathname: string): PrerenderedPublicPage {
  const route = prerenderRoutes.find((candidate) => candidate.path === pathname);
  if (route === undefined) throw new Error(`Unknown public route: ${pathname}`);
  // The same router component the browser hydrates with, so the markup matches.
  // Only the page that matches the path renders.
  const router = createMemoryRouter(appRoutes({
    docsRoute: <DocsRoute />,
    legalPage: <LegalRoute />,
    getPage: <GetRoute />,
    tokenListPage: <TokenListPage />,
  }), { initialEntries: [pathname] });
  return {
    pathname: route.path,
    ...route.metadata,
    html: renderToString(<RouterProvider router={router} />),
  };
}

export { clientRoutePrefixes, prerenderRoutes, routeManifest };
