#![allow(
    clippy::expect_used,
    reason = "registered RPC methods are static, validated server configuration"
)]
//! The operator-only `admin_*` namespace: peer inspection, peer management,
//! and operator source-verification publication.
//!
//! This is a separate namespace on a separate listener, not more methods on the
//! `pcash_*` port. Adding a peer makes the node open an outbound connection to
//! an address the caller chooses, and the `pcash_*` server is unauthenticated
//! with a permissive CORS layer so that browser wallets can reach it — which
//! would let any page the operator visits drive their node's dialer. Peer
//! topology is likewise operator information rather than public information.
//! An operator publication is the same kind of action: it writes to the node's
//! source registry under `node_operator` provenance, bypassing every bound the
//! permissionless channel puts on anonymous callers, and it rebuilds the
//! derived verification view for every contract.
//! [`serve_admin`] therefore binds its own socket, applies no CORS layer, and
//! serves HTTP only; the node binds it only when `--admin-addr` is given.
//!
//! Dropping the CORS layer is not by itself what keeps a browser out. Browsers
//! do not apply the same-origin policy to WebSocket connections, so a page can
//! open one to any reachable host whatever the CORS configuration says. Since
//! jsonrpsee serves HTTP and WebSocket on one socket by default, this listener
//! disables the WebSocket upgrade explicitly.

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;

use async_trait::async_trait;
use jsonrpsee::server::middleware::rpc::RpcServiceBuilder;
use jsonrpsee::server::{BatchRequestConfig, Server, ServerConfig, ServerHandle};
use jsonrpsee::types::{ErrorObject, ErrorObjectOwned, Params};
use jsonrpsee::RpcModule;
use pcash_metrics::Metrics;

use crate::dto::{AddPeerResultDto, NodeInfoDto, PeerInfoDto, RemovePeerResultDto};
use crate::server::RpcMetricsService;

/// `admin_addPeer` was given something that is not a dialable peer address.
const ADMIN_INVALID_ADDRESS: i32 = -32040;
/// The node has no P2P transport, because it was started with `--disable-p2p`.
const ADMIN_P2P_DISABLED: i32 = -32041;

/// One code per source-registry error class. Every listener that answers for
/// the registry uses these — operator publication here, the `pscan_*` read
/// surface in `pcash-pscan` — so a class means one number wherever a client
/// meets it, whichever socket answered.
pub const SOURCE_DISABLED_CODE: i32 = -32030;
pub const SOURCE_UNAVAILABLE_CODE: i32 = -32031;
pub const SOURCE_INVALID_CODE: i32 = -32032;
pub const SOURCE_CONFLICT_CODE: i32 = -32033;
pub const SOURCE_STORAGE_CODE: i32 = -32034;

/// Listener limit: the registry's compact publication ceiling plus room for
/// the JSON-RPC envelope and a client's less compact serialization.
pub const SOURCE_PUBLICATION_MAX_BODY_BYTES: u32 = 16 * 1024 * 1024;

/// The `Source*` variants carry the source registry's own error classes, each
/// under its own code, so a publisher can tell a malformed bundle from a
/// conflicting one from a node that cannot write at all.
#[derive(Debug, thiserror::Error)]
pub enum AdminApiError {
    #[error("P2P is disabled on this node")]
    Disabled,
    #[error("{0}")]
    InvalidAddress(String),
    #[error("{0}")]
    SourceDisabled(String),
    #[error("{0}")]
    SourceUnavailable(String),
    #[error("{0}")]
    SourceInvalid(String),
    #[error("{0}")]
    SourceConflict(String),
    #[error("{0}")]
    SourceStorage(String),
    #[error("{0}")]
    Internal(String),
}

impl From<AdminApiError> for ErrorObjectOwned {
    fn from(error: AdminApiError) -> Self {
        let code = match &error {
            AdminApiError::Disabled => ADMIN_P2P_DISABLED,
            AdminApiError::InvalidAddress(_) => ADMIN_INVALID_ADDRESS,
            AdminApiError::SourceDisabled(_) => SOURCE_DISABLED_CODE,
            AdminApiError::SourceUnavailable(_) => SOURCE_UNAVAILABLE_CODE,
            AdminApiError::SourceInvalid(_) => SOURCE_INVALID_CODE,
            AdminApiError::SourceConflict(_) => SOURCE_CONFLICT_CODE,
            AdminApiError::SourceStorage(_) => SOURCE_STORAGE_CODE,
            AdminApiError::Internal(_) => INTERNAL_ERROR,
        };
        ErrorObject::owned(code, error.to_string(), None::<()>)
    }
}

/// Peer inspection and management plus operator source publication. A node
/// started with `--disable-p2p` answers every peer method with
/// [`AdminApiError::Disabled`].
#[async_trait]
pub trait AdminApi: Send + Sync + 'static {
    /// Dial a peer and keep it in the redial set, so it behaves like a
    /// configured bootnode. Returns once the dial is scheduled, not once the
    /// connection is established.
    async fn add_peer(&self, address: String) -> Result<AddPeerResultDto, AdminApiError>;

    /// Disconnect a peer and drop it from the redial set, optionally banning it.
    async fn remove_peer(
        &self,
        peer_id: String,
        ban: bool,
    ) -> Result<RemovePeerResultDto, AdminApiError>;

    /// Connected peers, ordered by peer id.
    fn peers(&self) -> Result<Vec<PeerInfoDto>, AdminApiError>;

    /// This node's own transport identity, including the address another node
    /// passes to `admin_addPeer`.
    fn node_info(&self) -> Result<NodeInfoDto, AdminApiError>;

    /// Validate and persist an operator source-verification publication, and
    /// answer with the registry's status afterwards.
    ///
    /// Both sides cross as JSON because the source-verification crate depends
    /// on this one: naming its publication and info types here would invert
    /// that. The implementor owns the deserialization.
    fn publish_source_verification(
        &self,
        publication: serde_json::Value,
    ) -> Result<serde_json::Value, AdminApiError>;
}

type AdminCtx = Arc<dyn AdminApi>;

/// Shared with the public namespace so one code means one thing across both.
const INVALID_PARAMS: i32 = -32602;
const INTERNAL_ERROR: i32 = -32603;

fn encode<T: serde::Serialize>(value: &T) -> Result<serde_json::Value, ErrorObjectOwned> {
    serde_json::to_value(value)
        .map_err(|error| ErrorObject::owned(INTERNAL_ERROR, error.to_string(), None::<()>))
}

/// Decode `admin_addPeer` params from either `["<multiaddr>"]` or
/// `{"address": "<multiaddr>"}`.
fn address_param(params: &Params<'_>) -> Result<String, ErrorObjectOwned> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ByName {
        address: String,
    }
    params
        .sequence()
        .next::<String>()
        .or_else(|_| params.parse::<ByName>().map(|named| named.address))
        .map_err(|_| {
            ErrorObject::owned(
                INVALID_PARAMS,
                "expected a peer multiaddress ending in /p2p/<peer-id>",
                None::<()>,
            )
        })
}

/// Decode `admin_removePeer` params from either `["<peer-id>"]`,
/// `["<peer-id>", <ban>]`, or `{"peerId": "...", "ban": bool}`.
///
/// `ban` defaults to false only when it is *absent*: disconnecting is the lesser
/// action, so that is what an unqualified request gets. A `ban` that is present
/// but not a JSON boolean is an error rather than a silent false — quietly
/// downgrading `["peer", "true"]` to a plain disconnect would give a caller who
/// asked for a ban no indication they did not get one.
fn remove_peer_params(params: &Params<'_>) -> Result<(String, bool), ErrorObjectOwned> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct ByName {
        peer_id: String,
        #[serde(default)]
        ban: bool,
    }
    let invalid = |detail: &str| {
        ErrorObject::owned(
            INVALID_PARAMS,
            format!("expected a peer id and an optional boolean ban flag: {detail}"),
            None::<()>,
        )
    };

    // By-name first: a named object is not a sequence, so trying it here avoids
    // reporting a positional error for what is really a named request.
    if let Ok(named) = params.parse::<ByName>() {
        return Ok((named.peer_id, named.ban));
    }
    let mut sequence = params.sequence();
    let peer_id = sequence
        .next::<String>()
        .map_err(|error| invalid(&error.to_string()))?;
    let ban = match sequence.optional_next::<bool>() {
        Ok(ban) => ban.unwrap_or(false),
        Err(error) => return Err(invalid(&error.to_string())),
    };
    // A third positional argument means the caller is sending a shape this
    // method does not have; accepting it would hide the mistake.
    if sequence
        .optional_next::<serde_json::Value>()
        .is_ok_and(|extra| extra.is_some())
    {
        return Err(invalid("too many positional arguments"));
    }
    Ok((peer_id, ban))
}

/// Decode `admin_publishSourceVerification` params from `[<publication>]`.
///
/// `one` rejects a longer array, so a second positional argument is an error
/// rather than something silently dropped.
fn publication_param(params: &Params<'_>) -> Result<serde_json::Value, ErrorObjectOwned> {
    params.one::<serde_json::Value>().map_err(|_| {
        ErrorObject::owned(
            INVALID_PARAMS,
            "expected one self-contained source-verification publication object",
            None::<()>,
        )
    })
}

/// Register the `admin_*` namespace.
pub fn build_admin_module(api: AdminCtx) -> RpcModule<AdminCtx> {
    let mut m = RpcModule::new(api);

    m.register_async_method("admin_addPeer", |params, api, _| async move {
        let address = address_param(&params)?;
        api.add_peer(address)
            .await
            .map_err(ErrorObjectOwned::from)
            .and_then(|result| encode(&result))
    })
    .expect("admin_addPeer registers once");

    m.register_async_method("admin_removePeer", |params, api, _| async move {
        let (peer_id, ban) = remove_peer_params(&params)?;
        api.remove_peer(peer_id, ban)
            .await
            .map_err(ErrorObjectOwned::from)
            .and_then(|result| encode(&result))
    })
    .expect("admin_removePeer registers once");

    m.register_method("admin_peers", |_params, api, _| {
        api.peers()
            .map_err(ErrorObjectOwned::from)
            .and_then(|peers| encode(&peers))
    })
    .expect("admin_peers registers once");

    m.register_method("admin_nodeInfo", |_params, api, _| {
        api.node_info()
            .map_err(ErrorObjectOwned::from)
            .and_then(|info| encode(&info))
    })
    .expect("admin_nodeInfo registers once");

    // Blocking, not async: validating a publication rebuilds every new
    // implementation through the node's reproducer, which is synchronous and
    // long enough to stall the runtime's worker thread.
    m.register_blocking_method("admin_publishSourceVerification", |params, api, _| {
        let publication = publication_param(&params)?;
        api.publish_source_verification(publication)
            .map_err(ErrorObjectOwned::from)
    })
    .expect("admin_publishSourceVerification registers once");

    m
}

/// Bind the operator-only admin listener.
///
/// Two deliberate differences from the `pcash_*` server, both of which are the
/// browser boundary this namespace exists behind:
///
/// * **No CORS layer.** This is not meant to be reachable from a browser.
/// * **HTTP only.** A CORS layer would not have been enough on its own:
///   browsers do not apply the same-origin policy to WebSockets, so a
///   WebSocket-enabled admin socket is reachable from any page regardless of
///   CORS. jsonrpsee serves both transports on one socket by default, so the
///   WebSocket upgrade is turned off explicitly rather than left to the default.
///
/// The listener is unauthenticated, so its bind address remains its access
/// control: bind it to loopback or an operator-only interface.
pub async fn serve_admin(
    addr: SocketAddr,
    api: AdminCtx,
) -> std::io::Result<(SocketAddr, ServerHandle)> {
    serve_admin_with_metrics(addr, api, pcash_metrics::noop()).await
}

/// [`serve_admin`] with an injected recorder, so admin calls appear in the same
/// `rpc_*` metrics as public ones rather than being invisible.
pub async fn serve_admin_with_metrics(
    addr: SocketAddr,
    api: AdminCtx,
    metrics: Arc<dyn Metrics>,
) -> std::io::Result<(SocketAddr, ServerHandle)> {
    let module = build_admin_module(api);
    let registered_methods = Arc::new(module.method_names().collect::<HashSet<_>>());
    let rpc_middleware = RpcServiceBuilder::new().layer_fn(move |service| RpcMetricsService {
        service,
        metrics: Arc::clone(&metrics),
        registered_methods: Arc::clone(&registered_methods),
    });
    let config = ServerConfig::builder()
        .max_request_body_size(SOURCE_PUBLICATION_MAX_BODY_BYTES)
        .max_response_body_size(SOURCE_PUBLICATION_MAX_BODY_BYTES)
        // Publication validation rebuilds implementations on the blocking pool.
        // Batch fan-out multiplies that work and has no use on this namespace.
        .set_batch_request_config(BatchRequestConfig::Limit(1))
        .http_only()
        .build();
    let server = Server::builder()
        .set_config(config)
        .set_rpc_middleware(rpc_middleware)
        .build(addr)
        .await?;
    let local = server.local_addr()?;
    let handle = server.start(module);
    Ok((local, handle))
}
