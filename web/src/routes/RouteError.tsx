import { useRouteError } from "react-router-dom";
import { Metadata } from "./Metadata.tsx";

/** Replaces a page that failed to load or render, inside the site chrome. */
export function RouteError() {
  const error = useRouteError();
  return <div className="panel" role="alert">
    <Metadata title="Page unavailable" description="This PCASH page could not load." />
    <h1>This page could not load</h1>
    <p>The website may have been updated since this tab opened. Reload to get the latest version.</p>
    <p><small>{error instanceof Error ? error.message : String(error)}</small></p>
    <button type="button" className="button primary" onClick={() => location.reload()}>Reload</button>
  </div>;
}
