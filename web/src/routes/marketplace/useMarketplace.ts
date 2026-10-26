import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { publicationContractAddress,
  MarketplaceController,
  durableOfferPublications,
  fetchOpenOffers,
  hasCanonicalFunding,
  marketplaceActivity,
  publicationIdentity,
  quotePaymentRouterFee,
  verifyPaymentRouterDeployment,
  sharedOfferFromUrl,
  viemL1Signer,
  type MarketplaceBatchPurchase,
  type MarketplaceActivityItem,
  type MarketplaceProgress,
  type MarketplacePublishResult,
  type Offer,
  type OfferPublication,
  type OfferVerification,
  type PaymentRouterFeeQuote,
  type StoredOffer,
} from "@pcash/marketplace/app";
import type { Address } from "viem";
import { useNetwork } from "../../components/NetworkContext.tsx";
import { networkInstanceKey } from "../../lib/networks.ts";
import { PCASH_UNIT } from "../../components/pcashAmount.ts";
import { formatTokenAmount, parseUnitAmount, type AmountUnit } from "../../components/tokenAmount.ts";
import { encodeAssetDefinition } from "@pcash/sdk/protocol";
import { tokenUnit } from "../tokens/model.ts";
import { listingAssetLabel } from "./listingAsset.ts";
import { useWallet } from "../../lib/WalletProvider.tsx";
import type { ProveStatus } from "@pcash/sdk/browser-prover/requests";
import { recordProofTiming } from "../../components/proofStages.ts";
import { friendlyError } from "../../components/friendlyError.ts";
import {
  BROWSER_MARKETPLACE_OPERATION_LOCK,
  marketplaceStoreName,
  openMarketplaceStore,
  type IndexedDbMarketplaceStore,
} from "../../lib/MarketplaceStore.ts";
import { resolveMarketplaceRouterConfiguration } from "./configuration.ts";
import { marketplaceActivityAction } from "./recoveryPresentation.ts";
import { useMarketplaceTodos } from "./todos.ts";
import {
  isPublicCreatedOffer,
  marketplacePscanClient,
  publishMarketplaceSourceOpenings,
} from "./sourceOpenings.ts";
import {
  asBigint,
  offerShareUrl,
  portableOfferUrl,
} from "./presentation.ts";
import { parseListingPrice } from "./listingPrice.ts";

export const MarketplaceContext = createContext<MarketplaceModel | null>(null);

/** What a marketplace action works on: an exact publication, once it is known. */
export interface MarketplaceTrade {
  action: "buy" | "publish" | "reclaim" | "discard";
  identity?: string;
}

/** What the seller approved, shown while the listing is created. */
export interface ListingInputs {
  amount: bigint;
  unit: AmountUnit;
  price: bigint;
}

function samePublications(left: readonly OfferPublication[], right: readonly OfferPublication[]): boolean {
  return left.length === right.length
    && left.every((publication, index) => publicationIdentity(publication) === publicationIdentity(right[index]!));
}

/**
 * The status of the prover at work. A purchase or reclaim proves with the
 * marketplace's own prover, which reports through the trade's progress;
 * publishing a listing proves with the wallet's.
 */
export function activeProofStatus(trade: MarketplaceProgress | undefined, wallet: ProveStatus | undefined): ProveStatus | undefined {
  return trade?.step !== undefined ? trade : wallet;
}

export function useMarketplace() {
  return useContext(MarketplaceContext)!;
}

export function useMarketplaceController() {
  const { network } = useNetwork();
  const scope = networkInstanceKey(network);
  const router = useMemo(() => resolveMarketplaceRouterConfiguration({
    VITE_PAYMENT_ROUTER_ADDRESS: network.paymentRouterAddress,
  }), [network]);
  const pscan = useMemo(() => marketplacePscanClient(network.pscanUrl), [network.pscanUrl]);

  const {
    node,
    readStatus,
    profile,
    walletClient,
    selfPublication,
    phase,
    wallet,
    busy,
    runAction,
    progress: walletProof,
    awaitingSignature,
    connectedAccount,
    snapshot,
    funds,
    assertFasterGas,
  } = useWallet();
  const [verifiedRouter, setVerifiedRouter] = useState<{
    node: typeof node;
    l1RpcUrls: readonly string[];
    address: Address;
    config?: { feeRecipient: Address; feeBps: number };
    error?: string;
  }>();
  const [routerFeeAttempt, setRouterFeeAttempt] = useState(0);
  useEffect(() => {
    const address = router.configuration?.address;
    if (address === undefined) return;
    let cancelled = false;
    setVerifiedRouter(undefined);
    void verifyPaymentRouterDeployment(node, network.l1RpcUrls, address)
      .then((deployment) => {
        if (!cancelled) setVerifiedRouter({ node, l1RpcUrls: network.l1RpcUrls, address, config: deployment.config });
      })
      .catch((cause) => {
        if (!cancelled) setVerifiedRouter({ node, l1RpcUrls: network.l1RpcUrls, address, error: friendlyError(cause) });
      });
    return () => { cancelled = true; };
  }, [node, network.l1RpcUrls, router.configuration?.address, routerFeeAttempt]);
  const currentVerifiedRouter = verifiedRouter?.node === node &&
    verifiedRouter.l1RpcUrls === network.l1RpcUrls &&
    verifiedRouter.address === router.configuration?.address ? verifiedRouter : undefined;
  const location = useLocation();
  const navigate = useNavigate();
  // The session outlives the marketplace page; other pages never read its trades.
  const onMarketplace = location.pathname === "/marketplace" || location.pathname === "/marketplace/";
  const offerAddress = onMarketplace ? new URLSearchParams(location.search).get("offer")?.toLowerCase() : undefined;
  const currentOwner = useRef(profile?.address);
  currentOwner.current = profile?.address;
  useEffect(() => {
    currentOwner.current = profile?.address;
    return () => { currentOwner.current = undefined; };
  }, [profile?.address]);
  const [store, setStore] = useState<IndexedDbMarketplaceStore>();
  const [catalogOffers, setCatalogOffers] = useState<OfferPublication[]>([]);
  const sharedOffers = useMemo<OfferPublication[]>(() => {
    try {
      const publication = sharedOfferFromUrl(
        `${window.location.origin}${location.pathname}#${new URLSearchParams(location.search).get("publication") ?? ""}`,
      );
      return publication === null ? [] : [publication];
    } catch {
      return [];
    }
  }, [location.pathname, location.search]);
  const [localOffers, setLocalOffers] = useState<StoredOffer[]>([]);
  const [review, setReview] = useState<{
    publication: OfferPublication;
    verification: OfferVerification;
    controller: MarketplaceController;
    locationKey: string;
  }>();
  const [batchPurchase, setBatchPurchase] = useState<{
    publications: OfferPublication[]; owner: bigint; results?: MarketplaceBatchPurchase[]; error?: string;
  }>();
  useEffect(() => { setBatchPurchase(undefined); }, [profile?.address]);
  const [reviewError, setReviewError] = useState<string>();
  const [reviewAttempt, setReviewAttempt] = useState(0);
  const [createdListing, setCreated] = useState<{
    offer: Offer;
    publication: OfferPublication;
    shareUrl: string;
    catalogPublished: boolean;
    owner: bigint | undefined;
  }>();
  const [pendingPublication, setPendingPublication] = useState<OfferPublication>();
  const [listingInputs, setListingInputs] = useState<ListingInputs>();
  const [error, setError] = useState<string>();
  /** The last action's error, shown only where that action was started. */
  const [actionError, setActionError] = useState<{ trade: MarketplaceTrade; message: string }>();
  const [sourceNotices, setSourceNotices] = useState<
    { address: string; message: string }[]
  >([]);
  /** The last action's outcome, shown where that action was started. */
  const [message, setMessage] = useState<{ trade: MarketplaceTrade; text: string }>();
  const [progress, setProgress] = useState<MarketplaceProgress>();
  const [loading, setLoading] = useState(true);
  const [listingAmount, setListingAmount] = useState("");
  // 0 lists PCASH; any other value names a token this wallet holds with a verified definition.
  const [listingAssetId, setListingAssetId] = useState(0n);
  const listableTokens = useMemo(() => (snapshot?.assets ?? [])
    .flatMap((asset) => asset.definition !== null && asset.spendable > 0n ? [{ assetId: asset.assetId, definition: asset.definition, spendable: asset.spendable }] : []),
  [snapshot?.assets]);
  const listingToken = listingAssetId === 0n ? undefined : listableTokens.find((token) => token.assetId === listingAssetId);
  const listingUnit: AmountUnit = listingToken === undefined ? PCASH_UNIT : tokenUnit(listingToken.definition);
  // Listings are checked only once the first refresh has read what to check.
  const [candidatesRead, setCandidatesRead] = useState(false);
  const [ethPrice, setEthPrice] = useState("");
  const [purchaseMinutes, setPurchaseMinutes] = useState("10080");
  const sourcePublicationAttempt = useRef(0);
  const publishedSourceOpenings = useRef(new Set<string>());
  const actionInFlight = useRef(false);
  const actionCompletion = useRef<Promise<void> | undefined>(undefined);
  const [tradePending, setTradePending] = useState(false);
  const [activeTrade, setActiveTrade] = useState<MarketplaceTrade>();
  const [acceptedPurchase, setAcceptedPurchase] = useState<{
    paymentHash: string;
    claimContentHash: string;
    identity: string;
    owner: bigint | undefined;
  }>();
  const ready = phase === "ready";

  useEffect(() => {
    let opened: IndexedDbMarketplaceStore | undefined;
    let cancelled = false;
    void openMarketplaceStore(marketplaceStoreName(scope))
      .then((value) => {
        opened = value;
        if (cancelled) value.close();
        else setStore(value);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(friendlyError(cause));
          setLoading(false);
          setCandidatesRead(true);
        }
      });
    return () => {
      cancelled = true;
      // Authorized marketplace work continues across routes.
      // Keep its durable checkpoints writable until the submitted action finishes.
      if (actionCompletion.current !== undefined)
        void actionCompletion.current.finally(() => opened?.close());
      else opened?.close();
    };
  }, []);

  const controller = useMemo(
    () =>
      store === undefined
        ? undefined
        : new MarketplaceController({
            node,
            store,
            l1RpcUrls: network.l1RpcUrls,
            ...(router.configuration === undefined
              ? {}
              : { configuredRouter: router.configuration }),
            ...(walletClient === undefined || wallet === undefined
              ? {}
              : {
                  identity: {
                    wallet,
                    l1Signer: viemL1Signer(
                      walletClient,
                      wallet.address as Address,
                    ),
                  },
                }),
            onProgress: (next) => {
              recordProofTiming(next);
              // Background reads must not replace the progress of a submitted trade.
              if (
                currentOwner.current === profile?.address &&
                next.action !== "refresh" &&
                next.action !== "verify"
              )
                setProgress(next);
            },
            operationLock: BROWSER_MARKETPLACE_OPERATION_LOCK,
          }),
    [node, store, wallet, walletClient, profile?.address, network.l1RpcUrls, router.configuration?.address],
  );

  const currentController = useRef(controller);
  currentController.current = controller;
  const refreshing = useRef<
    { controller: MarketplaceController; promise: Promise<void>; reload?: Promise<void> } | undefined
  >(undefined);
  const refresh = useCallback(
    (quiet = false, reload = false): Promise<void> => {
      if (controller === undefined) return Promise.resolve();
      if (refreshing.current?.controller === controller) {
        // A publication or explicit Refresh must not settle for a read that
        // started before it. Coalesce requests into one subsequent read.
        if (!reload) return refreshing.current.promise;
        return refreshing.current.reload ??= refreshing.current.promise.then(() => currentRefresh.current());
      }
      const promise = (async () => {
        if (!quiet) setLoading(true);
        try {
          const result = await controller.refresh();
          if (currentController.current !== controller) return;
          setLocalOffers(result.localOffers);
          if (result.catalogError === undefined) setCatalogOffers(result.catalogOffers);
          const errors = [...(result.recoveryErrors ?? []), ...(result.catalogError === undefined ? [] : [result.catalogError])];
          setError(errors.length === 0 ? undefined : errors.map(friendlyError).join("; "));
          // Pscan keeps what it accepted; send each listing's openings until they publish.
          const created = result.localOffers.filter((offer) => isPublicCreatedOffer(offer)
            && !publishedSourceOpenings.current.has(publicationIdentity(offer.pub)));
          const attempt = ++sourcePublicationAttempt.current;
          if (created.length === 0) {
            setSourceNotices([]);
          } else if (pscan === undefined) {
            setSourceNotices(
              created.map((offer) => ({
                address: publicationContractAddress(offer.pub),
                message: "The explorer is unavailable, so it does not show this listing’s contract details. Your listing is not affected.",
              })),
            );
          } else {
            void (async () => {
              const outcomes = await Promise.allSettled(
                created.map((offer) =>
                  publishMarketplaceSourceOpenings(
                    pscan,
                    offer.pub,
                    readStatus,
                  ),
                ),
              );
              for (const [index, outcome] of outcomes.entries()) {
                if (outcome.status === "fulfilled" && outcome.value.status === "published")
                  publishedSourceOpenings.current.add(publicationIdentity(created[index]!.pub));
              }
              if (
                sourcePublicationAttempt.current !== attempt ||
                currentController.current !== controller
              )
                return;
              setSourceNotices(
                outcomes.flatMap((outcome, index) => {
                  if (
                    outcome.status === "fulfilled" &&
                    outcome.value.status === "published"
                  )
                    return [];
                  const message =
                    outcome.status === "fulfilled"
                      ? "The explorer is still verifying this listing’s contract. Your listing is not affected. Refresh later to show its details there."
                      : "The explorer could not show this listing’s contract details yet. Your listing is not affected. Refresh to try again.";
                  return [
                    {
                      address: publicationContractAddress(created[index]!.pub),
                      message,
                    },
                  ];
                }),
              );
            })();
          }
        } catch (cause) {
          if (currentController.current === controller)
            setError(friendlyError(cause));
        } finally {
          if (currentController.current === controller) {
            setLoading(false);
            setCandidatesRead(true);
          }
        }
      })();
      const request: NonNullable<typeof refreshing.current> = { controller, promise };
      refreshing.current = request;
      // Registered before any coalesced reload, so that reload starts a new read.
      void promise.finally(() => {
        if (refreshing.current === request) refreshing.current = undefined;
      });
      return promise;
    },
    [controller, readStatus, pscan],
  );
  const currentRefresh = useRef(refresh);
  currentRefresh.current = refresh;

  useEffect(() => {
    if (onMarketplace && !actionInFlight.current) void refresh();
    // Wallet approvals can replace the controller while an action is running.
    // Refresh the current controller once that action releases the wallet.
  }, [refresh, location.pathname, offerAddress, tradePending, onMarketplace]);

  const recoveredBoundary = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (wallet === undefined) return;
    recoveredBoundary.current = undefined;
    const unsubscribe = wallet.on("sync:completed", ({ syncedThrough }) => {
      // Ignore the refresh's own sync at this boundary; a later sync retries unavailable data.
      if (refreshing.current?.controller === controller && recoveredBoundary.current === syncedThrough.pcashHash) return;
      recoveredBoundary.current = syncedThrough.pcashHash;
      void refresh(true, true);
    });
    return () => { void unsubscribe(); };
  }, [wallet, controller, refresh]);

  const offers = useMemo(() => {
    const combined = new Map<string, OfferPublication>();
    for (const publication of catalogOffers)
      combined.set(publicationIdentity(publication), publication);
    for (const publication of sharedOffers)
      combined.set(publicationIdentity(publication), publication);
    for (const local of localOffers) {
      for (const publication of durableOfferPublications(local))
        combined.set(publicationIdentity(publication), publication);
    }
    return [...combined.values()];
  }, [catalogOffers, localOffers, sharedOffers]);

  useEffect(() => {
    if (store === undefined || progress?.publication === undefined) return;
    let cancelled = false;
    void store
      .list()
      .then((offers) => {
        if (!cancelled) setLocalOffers(offers);
      })
      .catch((cause) => {
        if (!cancelled)
          setError(friendlyError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [
    store,
    progress?.publication?.step,
    progress?.publication?.contentHash,
  ]);

  const [catalog, setCatalog] = useState<{
    node: typeof node;
    offers?: OfferPublication[];
    error?: string;
  }>();
  const [checkingListings, setCheckingListings] = useState(false);
  // Only the first check and an explicit Refresh show that listings are updating;
  // background rechecks replace the listings silently when they change.
  const announceListingCheck = useRef(true);
  const catalogCheck = useRef<{
    node: typeof node;
    sourceKey: string;
    promise: Promise<OfferPublication[]>;
  } | undefined>(undefined);
  const published = new Set(catalogOffers.map(publicationIdentity));
  const unfinished = new Set(localOffers
    .filter((offer) => offer.source === "created" && !isPublicCreatedOffer(offer))
    .map((offer) => publicationIdentity(offer.pub)));
  const listingCandidates = offers.filter((pub) => {
    const identity = publicationIdentity(pub);
    return published.has(identity) || !unfinished.has(identity);
  });
  const listingSourceKey = listingCandidates.map(publicationIdentity).join(":");
  useEffect(() => {
    if (!onMarketplace || !candidatesRead) return;
    let cancelled = false;
    const announced = announceListingCheck.current;
    if (announced) setCheckingListings(true);
    // Activity polling produces fresh objects for unchanged publications. Reuse
    // their in-flight check so polling cannot continually discard a slow read.
    const request = catalogCheck.current?.node === node && catalogCheck.current.sourceKey === listingSourceKey
      ? catalogCheck.current
      : { node, sourceKey: listingSourceKey, promise: fetchOpenOffers(node, listingCandidates) };
    catalogCheck.current = request;
    void request.promise
      .then((open) => {
        // Keep the rendered listings when nothing changed, so a recheck
        // re-renders nothing and a buyer's selection keeps its quote.
        if (!cancelled) setCatalog((current) => current?.node === node && current.error === undefined
          && current.offers !== undefined && samePublications(current.offers, open) ? current : { node, offers: open });
      })
      .catch((cause) => {
        if (!cancelled)
          setCatalog((current) => ({
            node,
            ...(current?.node === node && current.offers !== undefined ? { offers: current.offers } : {}),
            error: friendlyError(cause),
          }));
      })
      .finally(() => {
        if (catalogCheck.current === request) catalogCheck.current = undefined;
        if (!cancelled && announced) {
          announceListingCheck.current = false;
          setCheckingListings(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [node, listingSourceKey, onMarketplace, candidatesRead, offerAddress, reviewAttempt]);
  const currentCatalog =
    catalog?.node === node ? catalog : undefined;

  const activity = useMemo(
    () => marketplaceActivity(localOffers, profile?.address),
    [localOffers, profile?.address],
  );
  /** The signed-in owner's saved trades that wait on them, less a new listing whose progress the Create listing popup shows. */
  const savedTodos = useMarketplaceTodos(profile?.address, localOffers);
  const creating = tradePending && activeTrade?.action === "publish" && activeTrade.identity === undefined
    ? progress?.publication?.offerAddress : undefined;
  const todos = creating === undefined ? savedTodos
    : savedTodos.filter((item) => item.role !== "seller" || publicationContractAddress(item.publication) !== creating);
  const sellerQuote = useMemo<{
    quote?: PaymentRouterFeeQuote;
    error?: string;
    loading?: boolean;
  }>(() => {
    if (ethPrice.trim() === "" || listingAmount.trim() === "") return {};
    if (currentVerifiedRouter?.config === undefined) {
      return { loading: router.configuration !== undefined && currentVerifiedRouter?.error === undefined };
    }
    try {
      const buyerGrossWei = parseListingPrice(ethPrice);
      return {
        quote: quotePaymentRouterFee(buyerGrossWei, currentVerifiedRouter.config),
      };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [ethPrice, listingAmount, currentVerifiedRouter, router.configuration]);

  /** The listing form's values; each is undefined while its field is blank. */
  const sellerAmounts = useMemo<{
    amount?: bigint | undefined;
    error?: string;
    /** The PCASH this listing spends exceeds what the wallet can spend. */
    shortfall?: boolean;
  }>(() => {
    try {
      if (listingAssetId !== 0n && listingToken === undefined) throw new Error("Choose a token your wallet can list.");
      const amount = listingAmount.trim() === "" ? undefined : parseUnitAmount(listingAmount, listingUnit, { label: `${listingUnit.symbol} amount` });
      if (listingToken !== undefined && amount !== undefined && amount > listingToken.spendable) {
        throw new Error(`You have ${formatTokenAmount(listingToken.spendable, listingUnit, { rounding: "down" })} available to list.`);
      }
      // A PCASH listing's amount comes from the spendable PCASH the wallet panel shows.
      const pcash = listingToken === undefined ? amount ?? 0n : 0n;
      return { amount, shortfall: funds !== undefined && pcash > funds.spendablePrivate };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [listingAmount, listingAssetId, listingToken, listingUnit, funds]);

  const runMarketplaceAction = (
    action: () => Promise<string | undefined>,
    trade: MarketplaceTrade,
  ): void => {
    if (actionInFlight.current || busy) return;
    actionInFlight.current = true;
    setTradePending(true);
    setActiveTrade(trade);
    actionCompletion.current = runAction(async () => {
      setError(undefined);
      setMessage(undefined);
      if (trade.action !== "publish") setProgress(undefined);
      setActionError(undefined);
      try {
        const text = await action();
        if (currentOwner.current === profile?.address) setMessage(text === undefined ? undefined : { trade, text });
      } catch (cause) {
        if (currentOwner.current !== profile?.address) throw cause;
        setProgress((current) =>
          current !== undefined
            ? {
                ...current,
                phase: "error",
                message: friendlyError(cause),
              }
            : current,
        );
        throw cause;
      }
    })
      .catch((cause) => {
        if (currentOwner.current === profile?.address)
          setActionError({ trade, message: friendlyError(cause) });
      })
      .finally(async () => {
        // The saved offers were last read mid-action; show what the action saved
        // before its rows stop showing it as running.
        const saved = await store?.list().catch(() => undefined);
        if (saved !== undefined) setLocalOffers(saved);
        actionInFlight.current = false;
        setTradePending(false);
        setReviewAttempt((attempt) => attempt + 1);
      });
  };

  const created = createdListing?.owner === profile?.address ? createdListing : undefined;
  const selectedOffer = (
    offerAddress === undefined
      ? undefined
      : (sharedOffers.find(
          (offer) => publicationContractAddress(offer).toLowerCase() === offerAddress,
        ) ??
        (created !== undefined && publicationContractAddress(created.publication).toLowerCase() === offerAddress ? created.publication : undefined) ??
        offers.find(
          (offer) => publicationContractAddress(offer).toLowerCase() === offerAddress,
        )));
  const selectedIdentity =
    selectedOffer === undefined
      ? undefined
      : publicationIdentity(selectedOffer);
  const selectedOfferRef = useRef(selectedOffer);
  selectedOfferRef.current = selectedOffer;
  useEffect(() => {
    let cancelled = false;
    setReview(undefined);
    setReviewError(undefined);
    const publication = selectedOfferRef.current;
    if (
      publication === undefined ||
      controller === undefined ||
      router.configuration === undefined
    )
      return;
    // An opened wallet serializes its operations; wait until setup finishes before using it.
    if (wallet !== undefined && !ready) return;
    void controller
      .verify(publication)
      .then((verification) => {
        if (!cancelled)
          setReview({
            publication,
            verification,
            controller,
            locationKey: location.key,
          });
      })
      .catch((cause) => {
        if (!cancelled)
          setReviewError(
            friendlyError(cause),
          );
      });
    return () => {
      cancelled = true;
    };
  }, [
    selectedIdentity,
    controller,
    location.key,
    ready,
    wallet,
    reviewAttempt,
  ]);
  const currentReview =
    review !== undefined &&
    (wallet === undefined || ready) &&
    review.controller === controller &&
    review.locationKey === location.key &&
    publicationIdentity(review.publication) === selectedIdentity
      ? review
      : undefined;

  const buyReviewed = (): void => {
    if (
      controller === undefined ||
      currentReview === undefined ||
      !ready ||
      busy
    )
      return;
    runMarketplaceAction(
      async () => {
        const result = await controller.buy(currentReview.publication, buyOptions());
        setAcceptedPurchase({
          ...result,
          identity: publicationIdentity(currentReview.publication),
          owner: profile?.address,
        });
        return undefined;
      },
      { action: "buy", identity: selectedIdentity! },
    );
  };

  const buySelected = (publications: OfferPublication[]): void => {
    if (!ready || !controller || !profile || busy || actionInFlight.current) return;
    const selected = [...publications];
    const owner = profile.address;
    setBatchPurchase({ publications: selected, owner });
    runMarketplaceAction(async () => {
      try {
        const options = buyOptions();
        const results = await controller.buyMany(selected, options);
        options.assertActive();
        setBatchPurchase(current => current ? { ...current, results } : undefined);
      } catch (cause) {
        setBatchPurchase(current => current && { ...current, error: friendlyError(cause) });
        throw cause;
      }
      return undefined;
    }, { action: "buy" });
  };

  const assertActive = () => {
    if (currentOwner.current !== profile?.address || profile === undefined) {
      throw new Error("Your wallet changed. Open this trade with its original wallet to continue.");
    }
  };
  /**
   * A purchase pays and carries its claim in one Ethereum transaction the
   * connected wallet signs; the Marketplace checks that transaction's gas itself.
   */
  const buyOptions = () => {
    if (walletClient === undefined) throw new Error("Connect your Ethereum wallet to buy.");
    return { assertActive };
  };
  /** `ethereum` is false when the remaining work submits no Ethereum transaction, so it needs no gas. */
  const fastOptions = async (ethereum = true) => {
    if (selfPublication === undefined) throw new Error("Connect your Ethereum wallet to post to Ethereum.");
    if (ethereum) await assertFasterGas();
    const adapter = selfPublication;
    return { assertActive, submission: {
      ...adapter,
      preflight: async (context: Parameters<typeof adapter.preflight>[0]) => { assertActive(); return adapter.preflight(context); },
      submit: async (context: Parameters<typeof adapter.submit>[0]) => { assertActive(); return adapter.submit(context); },
    } };
  };

  const create = (event: FormEvent): void => {
    event.preventDefault();
    const quote = sellerQuote.quote;
    const { amount } = sellerAmounts;
    if (
      controller === undefined ||
      profile === undefined ||
      !ready ||
      busy ||
      quote === undefined ||
      sellerAmounts.error !== undefined ||
      sellerAmounts.shortfall === true ||
      amount === undefined
    )
      return;
    const token = listingToken;
    runMarketplaceAction(
      async () => {
        setListingInputs({ amount, unit: listingUnit, price: quote.buyerGrossWei });
        const result = await controller.createAndPublish({
          ...(token === undefined
            ? { assetId: 0n }
            : { assetId: token.assetId, assetDefinition: encodeAssetDefinition(token.definition) }),
          amount,
          ethPriceWei: quote.buyerGrossWei,
          purchaseMinutes: asBigint(purchaseMinutes, "purchase minutes"),
          fundingOpenFeeAmount: 0n,
        }, await fastOptions());
        if (currentOwner.current !== profile.address) return undefined;
        return publicationResult(result);
      },
      { action: "publish" },
    );
  };

  const finishPublication = (result: MarketplacePublishResult): string | undefined => {
    if (currentOwner.current !== profile?.address) return undefined;
    setPendingPublication(undefined);
    setActionError(undefined);
    setProgress((current) => current && ({ ...current, phase: "done", message: "Your listing is live." }));
    setCreated({
      offer: result.offer,
      publication: result.publication,
      shareUrl: portableOfferUrl(result.publication),
      catalogPublished: result.catalogPublished,
      owner: profile?.address,
    });
    // The wallet may still be refreshing its own state after this callback.
    // Buyers can read the now-published listing independently of that work.
    void currentRefresh.current(false, true);
    return "Your listing is live.";
  };

  const publicationResult = (result: MarketplacePublishResult): string | undefined => {
    if (currentOwner.current !== profile?.address) return undefined;
    if (result.catalogPublished) return finishPublication(result);
    const message = friendlyError(result.catalogError ?? "Your listing needs attention. Continue to make it available to buyers.");
    setActionError({ trade: { action: "publish", identity: publicationIdentity(result.publication) }, message });
    setProgress((current) => ({ action: "publish", elapsedMs: current?.elapsedMs ?? 0, phase: "error", message, publication: { step: "catalog" } }));
    setPendingPublication(result.publication);
    return undefined;
  };

  const finalize = (publication = pendingPublication): void => {
    if (controller === undefined || publication === undefined || walletClient === undefined || profile === undefined || !ready || busy || actionInFlight.current) return;
    const identity = publicationIdentity(publication);
    runMarketplaceAction(async () => {
      setListingInputs(undefined);
      setCreated(undefined);
      setPendingPublication(publication);
      setProgress({ action: "publish", phase: "preparing", message: "Checking your saved listing and transactions…", elapsedMs: 0, publication: { step: "funding" } });
      // A listing whose escrow funding is canonical has only its catalog publication left.
      const saved = localOffers.find((offer) => publicationIdentity(offer.pub) === identity);
      const ethereum = saved?.pub.escrow === undefined || !hasCanonicalFunding(saved.publish);
      return publicationResult(await controller.resumePublication(publication, await fastOptions(ethereum)));
    }, { action: "publish", identity });
  };

  /** Forget a listing whose escrow funding never started. */
  const discardListing = (item: MarketplaceActivityItem): void => {
    if (controller === undefined || item.role !== "seller") return;
    const identity = publicationIdentity(item.publication);
    const address = publicationContractAddress(item.publication).toLowerCase();
    runMarketplaceAction(async () => {
      await controller.discardUnfundedPublication(item.publication);
      if (pendingPublication !== undefined && publicationIdentity(pendingPublication) === identity) setPendingPublication(undefined);
      if (store !== undefined) setLocalOffers(await store.list());
      // Its details are gone; the account's other trades stay.
      if (offerAddress === address) navigate({ pathname: location.pathname }, { replace: true, preventScrollReset: true });
      return "Listing discarded.";
    }, { action: "discard", identity });
  };

  const runActivityAction = (item: MarketplaceActivityItem): void => {
    if (controller === undefined) return;
    const action = marketplaceActivityAction(item);
    if (action === "refresh") {
      void refresh();
      return;
    }
    if (action === "resume-purchase" || action === "check-payment") {
      runMarketplaceAction(
        async () => {
          const result = await controller.buy(item.publication, buyOptions());
          setAcceptedPurchase({
            ...result,
            identity: publicationIdentity(item.publication),
            owner: profile?.address,
          });
          return undefined;
        },
        { action: "buy", identity: publicationIdentity(item.publication) },
      );
      return;
    }
    if (action === "resume-publication") {
      finalize(item.publication);
      return;
    }
    if (action === "reclaim") {
      runMarketplaceAction(
        async () => {
          await controller.reclaim(item.publication, 0n, await fastOptions());
          return `Reclaim submitted. Your ${listingAssetLabel(item.publication)} returns once it is confirmed.`;
        },
        { action: "reclaim", identity: publicationIdentity(item.publication) },
      );
    }
  };

  useEffect(() => {
    setListingInputs(undefined);
    setCreated(undefined);
    setPendingPublication(undefined);
    setAcceptedPurchase(undefined);
    setActiveTrade(undefined);
    setProgress(undefined);
    setActionError(undefined);
    setMessage(undefined);
  }, [profile?.address]);

  const listingLink = (publication: OfferPublication): string => {
    const identity = publicationIdentity(publication);
    const published = catalogOffers.some((offer) => publicationIdentity(offer) === identity)
      || (created?.catalogPublished === true && publicationIdentity(created.publication) === identity);
    return published ? offerShareUrl(publication) : portableOfferUrl(publication);
  };

  const reviewedQuote = currentReview?.verification.feeQuote ?? undefined;

  // Poll only while the network can move a trade forward on its own: Ethereum
  // can still include a submitted claim or reclaim. Failed trades, and trades
  // waiting on their owner, change only when the owner acts.
  const pendingActivity = activity.some((item) => item.status === "pending"
    || (item.contentHash !== undefined && item.phase === "reclaim-prepared"));
  useEffect(() => {
    if (!onMarketplace) return;
    let cancelled = false;
    let reading = false;
    const update = async () => {
      if (document.visibilityState === "hidden" || reading) return;
      reading = true;
      try {
        if (actionInFlight.current) {
          const saved = await store?.list();
          if (!cancelled && saved !== undefined) setLocalOffers(saved);
        } else if (!busy) {
          await refresh(true);
          if (!cancelled) setReviewAttempt((attempt) => attempt + 1);
        }
      } catch (cause) {
        if (!cancelled)
          setError(friendlyError(cause));
      } finally {
        reading = false;
      }
    };
    const focus = () => {
      void update();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    const timer =
      pendingActivity || tradePending
        ? window.setInterval(focus, 5_000)
        : undefined;
    return () => {
      cancelled = true;
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      window.clearInterval(timer);
    };
  }, [
    store,
    refresh,
    pendingActivity,
    tradePending,
    busy,
    onMarketplace,
  ]);

  const purchase = activity.find(
    (item) =>
      item.role === "buyer" &&
      publicationIdentity(item.publication) === selectedIdentity,
  );
  const selectedSeller = activity.find((item) => item.role === "seller" && publicationIdentity(item.publication) === selectedIdentity);
  const routeSeller = offerAddress === undefined ? undefined : activity.find((item) => item.role === "seller"
    && publicationContractAddress(item.publication).toLowerCase() === offerAddress);
  const buyingSelected =
    selectedIdentity !== undefined &&
    tradePending &&
    activeTrade?.action === "buy" &&
    activeTrade.identity === selectedIdentity;
  const purchaseAccepted =
    selectedIdentity !== undefined &&
    acceptedPurchase?.identity === selectedIdentity &&
    acceptedPurchase.owner === profile?.address;
  // A listing that failed after one of its transactions was saved continues; publishing again would create another listing.
  const failedPublication = progress?.phase === "error" && progress.publication?.contentHash !== undefined
    ? localOffers.find((offer) => publicationContractAddress(offer.pub) === progress.publication!.offerAddress)?.pub : undefined;
  const savedPublication = pendingPublication ?? failedPublication;
  return {
    location,
    offerAddress,
    profile,
    ready,
    busy: busy || tradePending,
    tradePending,
    batchPurchase: batchPurchase?.owner === profile?.address ? batchPurchase : undefined,
    buySelected,
    closeBatchPurchase: () => setBatchPurchase(undefined),
    controller,
    configuration: router.configuration,
    configurationError: router.error ?? currentVerifiedRouter?.error,
    /** The fee terms read from the configured router's deployment, once verified. */
    routerTerms: currentVerifiedRouter?.config,
    loading,
    error,
    /** The last action's error, where `matches` names the action shown here. */
    actionErrorFor: (matches: (trade: MarketplaceTrade) => boolean) => actionError !== undefined && matches(actionError.trade) ? actionError.message : undefined,
    messageFor: (matches: (trade: MarketplaceTrade) => boolean) => message !== undefined && matches(message.trade) ? message.text : undefined,
    /**
     * The action in flight is submitting its Ethereum transaction, which the
     * wallet asks the user to approve; a listing's catalog step comes after.
     */
    confirmInWallet: tradePending && progress?.phase === "submitting" && progress.publication?.step !== "catalog",
    sourceNotices,
    progress,
    proofProgress: activeProofStatus(progress, walletProof),
    awaitingSignature,
    pendingPublication: savedPublication,
    finalize: () => finalize(savedPublication),
    activeTrade,
    currentCatalog,
    checkingListings,
    selectedOffer,
    currentReview,
    reviewError,
    retryVerification: () => {
      announceListingCheck.current = true;
      setReviewAttempt((attempt) => attempt + 1);
      // A verified deployment is immutable; only a failed check is worth repeating.
      if (currentVerifiedRouter?.error !== undefined) setRouterFeeAttempt((attempt) => attempt + 1);
    },
    refresh,
    todos,
    /** The signed-in owner's saved trades. */
    activity,
    /** Whether the action in flight works on this saved trade; a new listing is named once its funding transaction is prepared. */
    running: (item: MarketplaceActivityItem): boolean => tradePending && activeTrade !== undefined
      && (activeTrade.identity === undefined
        ? activeTrade.action === "publish" && item.role === "seller" && progress?.publication?.offerAddress === publicationContractAddress(item.publication)
        : activeTrade.identity === publicationIdentity(item.publication)),
    purchase,
    // The checkout is the buyer's: a wallet that bought its own listing sees its purchase here, and its listing in the orderbook.
    selectedActivity: purchase === undefined ? selectedSeller ?? routeSeller : undefined,
    buyingSelected,
    purchaseAccepted,
    listingAmount,
    setListingAmount,
    listingAssetId,
    setListingAssetId: (assetId: bigint) => { setListingAssetId(assetId); setListingAmount(""); },
    listableTokens,
    listingUnit,
    ethPrice,
    setEthPrice,
    purchaseMinutes,
    setPurchaseMinutes,
    sellerAmounts,
    sellerQuote,
    reviewedQuote,
    created,
    listingInputs,
    newListing: () => {
      // A draft that failed before submission stays in the form.
      if (created !== undefined || pendingPublication !== undefined) {
        setListingAmount("");
        setEthPrice("");
      }
      setListingInputs(undefined);
      setCreated(undefined);
      setPendingPublication(undefined);
      setProgress(undefined);
    },
    create,
    buyReviewed,
    listingLink,
    runActivityAction,
    discardListing,
  };
}

export type MarketplaceModel = ReturnType<typeof useMarketplaceController>;
