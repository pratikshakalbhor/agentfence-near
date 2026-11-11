//! Audit log types for `agentfence`.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

/// The outcome of a policy check.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// The action was allowed by policy.
    Allowed,
    /// The action was blocked by policy.
    Blocked,
}

/// The `big_r` point of a signature (flat MPC shape).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AffinePoint {
    /// Affine point encoding.
    pub affine_point: String,
}

/// The `s` scalar of a signature (flat MPC shape).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scalar {
    /// Scalar value.
    pub scalar: String,
}

/// A signature in the testnet MPC contract's flat shape.
///
/// Unknown JSON fields (e.g. `scheme: "Secp256k1"`) are ignored by serde.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignatureOut {
    /// The `big_r` point.
    pub big_r: AffinePoint,
    /// The `s` scalar.
    pub s: Scalar,
    /// Recovery id.
    pub recovery_id: u8,
}

/// The MPC `sign` response shape received by the `on_sign` callback.
pub type SignResult = SignatureOut;

/// The synchronous result returned by `request_spend` / `on_sign`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpendResult {
    /// Whether the spend was allowed or blocked.
    pub decision: Decision,
    /// Why it was blocked, if it was.
    pub reason: Option<String>,
    /// The MPC signature, present only when an allowed spend's callback
    /// succeeded.
    pub signature: Option<SignatureOut>,
    /// Hex of the keccak256 signing hash that was (or will be) signed, so the
    /// agent can verify it.
    pub payload_hash: Option<String>,
    /// Hex of the unsigned serialized EVM transaction.
    pub unsigned_tx: Option<String>,
}

/// A single append-only audit record.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditEntry {
    /// Monotonic index of this entry in the log.
    pub id: u64,
    /// When the entry was recorded (unix nanos).
    pub timestamp: u64,
    /// The agent that proposed the spend.
    pub agent_id: AccountId,
    /// Intended destination.
    pub destination: String,
    /// Amount that was proposed.
    pub amount: U128,
    /// Whether policy allowed or blocked it.
    pub decision: Decision,
    /// Why it was blocked, if it was.
    pub reason: Option<String>,
}
