import { Link } from "react-router-dom";
import { Metadata } from "./Metadata.tsx";
import { ExplorerSearchForm } from "./explorer/ExplorerSearchForm.tsx";

export function NotFound() {
  return <div className="panel">
    <Metadata title="Not found" description="The requested PCASH page does not exist." />
    <h1>Not found</h1>
    <p>There is no page at this address. If you were looking for an account, block or transaction, search for it.</p>
    <ExplorerSearchForm />
    <p><Link to="/">Home</Link> · <Link to="/explorer">Explorer</Link> · <Link to="/marketplace">Marketplace</Link></p>
  </div>;
}
