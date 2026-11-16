//! The node's persistent P2P identity file.
//!
//! The file at `$PCASH_DATA_DIR/p2p_identity.pb` holds an Ed25519 keypair in libp2p's
//! `PrivateKey` protobuf encoding — no wrapper, no armour, exactly the bytes
//! `Keypair::to_protobuf_encoding` produces. It is not disposable state: the
//! peer id derived from it is what other operators dial, and peer reputation is
//! scored against it, so replacing it silently changes who this node is on the
//! network.
//!
//! Two audiences read this module. The node calls [`load_or_create_identity`] on
//! start, or [`identity_from_hex`] when the operator supplies the same bytes from a
//! secret store. Operators call [`generate_identity_file`] and [`inspect_identity_file`]
//! through `pcash-cli p2p-key`, and those return [`IdentityFileInfo`] — an account
//! with no accessor for key material at all. That is deliberate: the private
//! half cannot leak into a CLI rendering because it never leaves this module.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use libp2p::identity::Keypair;
use libp2p::PeerId;
use sha2::{Digest, Sha256};

use crate::types::Error;

/// The node's persistent transport identity: read it if it is there, mint it if
/// it is not.
pub fn load_or_create_identity(path: &Path) -> Result<Keypair, Error> {
    if path.exists() {
        return read_identity(path);
    }
    create_identity(path)
}

/// An identity supplied as the hex of an identity file's bytes, for a node whose
/// key lives in a secret store rather than in its data directory.
pub fn identity_from_hex(encoded: &str) -> Result<Keypair, Error> {
    // The decoder's own error quotes the offending character; key material is
    // never worth that.
    let bytes = hex::decode(encoded.trim().trim_start_matches("0x"))
        .map_err(|_| Error::IdentityEncoding("identity key is not hex".to_owned()))?;
    Keypair::from_protobuf_encoding(&bytes).map_err(|e| Error::IdentityEncoding(e.to_string()))
}

/// Everything about an identity file that is safe to show an operator.
///
/// There is no field and no method here that exposes the private half. An
/// operator tool built on this can render the whole struct without review.
#[derive(Clone, Debug)]
pub struct IdentityFileInfo {
    pub path: PathBuf,
    /// The network identity other nodes dial and score.
    pub peer_id: PeerId,
    /// The keypair's algorithm as the file actually encodes it, so a file that
    /// is not the Ed25519 the node expects is reported rather than mislabelled.
    pub key_type: String,
    /// The raw 32-byte Ed25519 public key.
    pub public_key: [u8; 32],
    /// SHA-256 over the file's bytes.
    ///
    /// This discloses nothing `peer_id` does not: the peer id already pins the
    /// keypair uniquely, and a preimage attack on a 32-byte Ed25519 seed is not
    /// a thing. It exists to tell apart two byte-different files that hold the
    /// same key, which a peer id cannot do.
    pub file_sha256: [u8; 32],
    /// The unix permission bits, where there are any.
    pub file_mode: Option<u32>,
}

impl IdentityFileInfo {
    /// Whether group or other can read the file. A private key at `0o644` is a
    /// live incident, not a style problem.
    pub fn insecure_permissions(&self) -> bool {
        self.file_mode.is_some_and(|mode| mode & 0o077 != 0)
    }
}

/// The outcome of minting an identity file.
#[derive(Clone, Debug)]
pub struct GeneratedIdentity {
    pub info: IdentityFileInfo,
    /// Under `force`, the peer id of the key that was overwritten, so a
    /// rotation leaves an account of the identity it retired. `None` when nothing
    /// was replaced, or when the replaced file could not be decoded.
    pub replaced: Option<PeerId>,
}

/// Mint an identity file and report its public facts.
///
/// Without `force` this refuses to touch an existing path. With it, the
/// replacement is written to a sibling temporary file and renamed into place, so
/// an interrupted rotation leaves either the old key or the new one — never a
/// truncated file the node cannot start from.
pub fn generate_identity_file(path: &Path, force: bool) -> Result<GeneratedIdentity, Error> {
    if !force {
        let keypair = create_identity(path)?;
        return Ok(GeneratedIdentity {
            info: info_for(path, &keypair)?,
            replaced: None,
        });
    }

    // Best effort: a corrupt or absent file is not a reason to block a rotation,
    // it just means there is no retired peer id to report.
    let replaced = read_identity(path)
        .ok()
        .map(|keypair| keypair.public().to_peer_id());

    create_parent(path)?;
    let keypair = Keypair::generate_ed25519();
    let temp = temp_path(path);
    // A leftover temporary from a previous interrupted run would otherwise make
    // `create_new` fail forever.
    let _ = fs::remove_file(&temp);
    write_identity(&temp, &keypair)?;
    fs::rename(&temp, path)?;
    sync_parent(path)?;

    Ok(GeneratedIdentity {
        info: info_for(path, &keypair)?,
        replaced,
    })
}

/// Report the public facts about an existing identity file.
///
/// This never creates: an operator checking which key is on a host must get an
/// error for a mistyped path, not a freshly minted key and a confident answer.
pub fn inspect_identity_file(path: &Path) -> Result<IdentityFileInfo, Error> {
    let keypair = read_identity(path)?;
    info_for(path, &keypair)
}

fn info_for(path: &Path, keypair: &Keypair) -> Result<IdentityFileInfo, Error> {
    let bytes = fs::read(path)?;
    let public = keypair.public();
    let peer_id = public.to_peer_id();
    let public_key = public
        .try_into_ed25519()
        .map_err(|e| Error::IdentityEncoding(e.to_string()))?
        .to_bytes();
    Ok(IdentityFileInfo {
        path: path.to_path_buf(),
        peer_id,
        key_type: format!("{:?}", keypair.key_type()),
        public_key,
        file_sha256: Sha256::digest(&bytes).into(),
        file_mode: file_mode(path)?,
    })
}

#[cfg(unix)]
fn file_mode(path: &Path) -> Result<Option<u32>, Error> {
    use std::os::unix::fs::PermissionsExt;
    Ok(Some(fs::metadata(path)?.permissions().mode() & 0o777))
}

#[cfg(not(unix))]
fn file_mode(_path: &Path) -> Result<Option<u32>, Error> {
    Ok(None)
}

/// Read an existing identity file. Never creates one: a caller that only wants
/// to look at a key must not mint a new one because the path was mistyped.
fn read_identity(path: &Path) -> Result<Keypair, Error> {
    let bytes = fs::read(path)?;
    Keypair::from_protobuf_encoding(&bytes).map_err(|e| Error::IdentityEncoding(e.to_string()))
}

/// Mint an identity and persist it at `path`, refusing to clobber an existing
/// file. The refusal is `create_new`, not a prior existence check, so two
/// processes racing cannot both believe they created the key.
fn create_identity(path: &Path) -> Result<Keypair, Error> {
    create_parent(path)?;
    let keypair = Keypair::generate_ed25519();
    write_identity(path, &keypair)?;
    Ok(keypair)
}

fn create_parent(path: &Path) -> Result<(), Error> {
    if let Some(parent) = parent_of(path) {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

/// Durability for the rename itself: without fsyncing the directory, a crash can
/// leave the entry pointing at neither file.
fn sync_parent(path: &Path) -> Result<(), Error> {
    if let Some(parent) = parent_of(path) {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn parent_of(path: &Path) -> Option<&Path> {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
}

/// A sibling of the target, so the rename that follows stays within one
/// filesystem and is therefore atomic.
fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    match parent_of(path) {
        Some(parent) => parent.join(name),
        None => PathBuf::from(name),
    }
}

/// Write the keypair to a path that must not already exist, owner-readable only.
///
/// The mode is set at create time rather than chmod'ed afterwards, so the file
/// is never briefly world-readable while it holds a private key.
fn write_identity(path: &Path, keypair: &Keypair) -> Result<(), Error> {
    let encoded = keypair
        .to_protobuf_encoding()
        .map_err(|e| Error::IdentityEncoding(e.to_string()))?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(&encoded)?;
    file.sync_all()?;
    Ok(())
}
