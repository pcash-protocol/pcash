import { useNativeActivity } from "./lib/useNativeActivity.ts";
import { WebsiteSettingsProvider } from "./lib/WebsiteSettings.tsx";
import { NameResolutionProvider } from "./names/NameResolutionProvider.tsx";
import { createEthereumNames } from "./lib/ethereumNames.ts";
import { lazy, useMemo, type ReactNode } from "react";
import { ScrollRestoration, useLocation, useParams, type RouteObject } from "react-router-dom";
import { PersonalTransactionDetailsProvider, type PersonalTransactionDetailsValue } from "./components/PersonalTransactionDetails.tsx";
import { EthereumProvider } from "./lib/EthereumProvider.tsx";
import { NetworkProvider } from "./lib/NetworkProvider.tsx";
import { useWallet, WalletProvider } from "./lib/WalletProvider.tsx";
import { ExplorerProvider } from "./routes/explorer/ExplorerProvider.tsx";
import { OwnerPanelsProvider } from "./routes/wallet/OwnerPanels.tsx";
import { GetActivityProvider } from "./lib/GetActivity.tsx";
import { WalletPanel } from "./components/WalletPanel.tsx";
import { MarketplaceProvider } from "./routes/marketplace/MarketplaceProvider.tsx";
import DevelopersRoute from "./routes/developers/DevelopersRoute.tsx";
import { isExplorerPath, isIdentityPath } from "./routes/explorer/paths.ts";
import { HomeRoute } from "./routes/home/HomeRoute.tsx";
import { NotFound } from "./routes/NotFound.tsx";
import { RouteError } from "./routes/RouteError.tsx";
import { SiteChrome } from "./routes/SiteChrome.tsx";
import { routeById } from "./routes/routeManifest.ts";
import { parseAssetIdSegment } from "./routes/tokens/model.ts";

const LazyDocsRoute = lazy(() => import("./routes/docs/DocsRoute.tsx"));
const LazyLegalRoute = lazy(() => import("./routes/legal/LegalRoute.tsx"));
const ExplorerRoute = lazy(() => import("./routes/explorer/ExplorerRoute.tsx"));
const AddressRoute = lazy(() => import("./routes/address/AddressRoute.tsx"));
const MarketplaceRoute = lazy(() => import("./routes/marketplace/MarketplaceRoute.tsx"));
const GetRoute = lazy(() => import("./routes/get/GetRoute.tsx"));
const TokenListRoute = lazy(() => import("./routes/tokens/TokenListPage.tsx"));
const CreateTokenRoute = lazy(() => import("./routes/tokens/CreateTokenPage.tsx"));
const TokenRoute = lazy(() => import("./routes/tokens/TokenPage.tsx"));
const ClaimRoute = lazy(() => import("./routes/tokens/ClaimPage.tsx"));
const DropRoute = lazy(() => import("./routes/tokens/DropPage.tsx"));
const MessagesRoute = lazy(() => import("./routes/messages/MessagesRoute.tsx"));
const fixtureMode = import.meta.env.VITE_PCASH_MODE === "fixtures";
// Guarded so a non-fixture build never emits the states page or the world it imports.
const StatesRoute = fixtureMode ? lazy(() => import("./routes/fixtures/StatesRoute.tsx")) : undefined;

const homeRoute = routeById("home");
const learnRoute = routeById("learn");
const developersRoute = routeById("developers");
const explorerRoute = routeById("explorer");
const marketplaceRoute = routeById("marketplace");
const getRoute = routeById("get");
const tokensRoute = routeById("tokens");
const newTokenRoute = routeById("token-new");
const tokenRoute = routeById("token");
const claimRoute = routeById("claim");
const dropRoute = routeById("drop");
const messagesRoute = routeById("messages");
const termsRoute = routeById("terms");
const privacyRoute = routeById("privacy");

// Chain objects and identities both live at the site root (/blocks, /tx/:id,
// /0x…, /alice.eth), so this is the catch-all. An identity always contains a
// dot or starts with 0x, which is what lets both share the root with no
// reserved-word list. The not-found decision is made here, before the lazy
// boundary, so an unknown path loads neither chunk.
function RootRoute() {
  const { pathname } = useLocation();
  if (isIdentityPath(pathname)) return <AddressRoute />;
  if (isExplorerPath(pathname)) return <ExplorerRoute metadata={explorerRoute.metadata} />;
  return <NotFound />;
}

/** A malformed token ID is decided here, before the lazy boundary, like unknown root paths. */
function TokenPageRoute() {
  const { assetId = "" } = useParams();
  return parseAssetIdSegment(assetId) === undefined ? <NotFound /> : <TokenRoute />;
}

function DropPageRoute() {
  const { contractAddress = "" } = useParams();
  return /^0x[0-9a-fA-F]{40}$/.test(contractAddress) ? <DropRoute /> : <NotFound />;
}

function WalletPersonalTransactionDetails({ children }: { children: ReactNode }) {
  const { profile, snapshot, paymentActivity } = useWallet();
  const native = useNativeActivity();
  const nativeHistory = native.activity?.state === "ready" ? native.activity : undefined;
  const value = useMemo<PersonalTransactionDetailsValue>(() => profile === undefined || snapshot === undefined
    ? { payments: [] }
    : {
      network: snapshot.network,
      payments: paymentActivity.map((payment) => ({
        contentHash: payment.contentHash,
        kind: payment.kind,
        ...(payment.kind === "mine" && nativeHistory !== undefined && !native.failed && nativeHistory.pcashHash === snapshot.syncedThrough?.pcashHash ? {
          minedAmount: nativeHistory.entries.find((entry) => ((payment.receiptTxId !== undefined && entry.transactionId?.toLowerCase() === payment.receiptTxId.toLowerCase()) || entry.contentHash?.toLowerCase() === payment.contentHash.toLowerCase()))?.payout?.issuanceAmount ?? 0n,
        } : {}),
        recipientAddress: payment.recipientAddress,
        amount: payment.amount,
        openFeeAmount: payment.openFeeAmount,
      })),
    }, [paymentActivity, profile, snapshot, nativeHistory, native.failed]);
  return <PersonalTransactionDetailsProvider value={value}>{children}</PersonalTransactionDetailsProvider>;
}

/** The explorer reads the node status the signed-in wallet already follows instead of polling it again. */
function WalletExplorerProvider({ children }: { children: ReactNode }) {
  const { followedStatus } = useWallet();
  return <ExplorerProvider followedStatus={followedStatus}>{children}</ExplorerProvider>;
}

function Root() {
  // One wallet runtime for the whole site: the account widget is live on every
  // page, and Explorer, Get PCASH, and Marketplace all read the same connection
  // instead of asking the visitor to connect again.
  return <WebsiteSettingsProvider><NameResolutionProvider createResolver={fixtureMode ? undefined : createEthereumNames}><NetworkProvider><EthereumProvider><WalletProvider><WalletPersonalTransactionDetails><GetActivityProvider><OwnerPanelsProvider><WalletPanel /><WalletExplorerProvider>
    <MarketplaceProvider><SiteChrome /><ScrollRestoration /></MarketplaceProvider>
  </WalletExplorerProvider></OwnerPanelsProvider></GetActivityProvider></WalletPersonalTransactionDetails></WalletProvider></EthereumProvider></NetworkProvider></NameResolutionProvider></WebsiteSettingsProvider>;
}

/** The site's routes. Each page element given here renders without the lazy boundary, for prerendering and hydration. */
export function appRoutes({ docsRoute, legalPage, getPage, tokenListPage }: {
  docsRoute?: ReactNode;
  legalPage?: ReactNode;
  getPage?: ReactNode;
  tokenListPage?: ReactNode;
} = {}): RouteObject[] {
  return [{
    element: <Root />,
    // A failure in the providers or site chrome still gets the reload page.
    errorElement: <RouteError />,
    children: [{
      // Pathless so a failed page renders its error inside the header and wallet.
      errorElement: <RouteError />,
      children: [
        { path: homeRoute.path, element: <HomeRoute /> },
        { path: `${learnRoute.path}/*`, element: docsRoute ?? <LazyDocsRoute /> },
        { path: developersRoute.path, element: <DevelopersRoute /> },
        { path: getRoute.path, element: getPage ?? <GetRoute /> },
        { path: `${marketplaceRoute.path}/*`, element: <MarketplaceRoute /> },
        { path: tokensRoute.path, element: tokenListPage ?? <TokenListRoute /> },
        { path: newTokenRoute.path, element: <CreateTokenRoute /> },
        { path: tokenRoute.path, element: <TokenPageRoute /> },
        { path: claimRoute.path, element: <ClaimRoute /> },
        { path: dropRoute.path, element: <DropPageRoute /> },
        { path: `${messagesRoute.path}/*`, element: <MessagesRoute /> },
        { path: termsRoute.path, element: legalPage ?? <LazyLegalRoute /> },
        { path: privacyRoute.path, element: legalPage ?? <LazyLegalRoute /> },
        ...StatesRoute === undefined ? [] : [{ path: "/__states", element: <StatesRoute /> }],
        { path: "*", element: <RootRoute /> },
      ],
    }],
  }];
}
