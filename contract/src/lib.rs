//! `agentfence` — a policy-enforced agent treasury.
//!
//! Status: work in progress. Data types, owner-only admin methods,
//! `request_spend` (policy gate + audit log + MPC signature).

mod audit;
mod policy;

pub use audit::{AuditEntry, Decision, SignResult, SignatureOut, SpendResult};
pub use policy::{Policy, SpendWindow};

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupSet, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue};
use omni_transaction::evm::utils::parse_eth_address;
use omni_transaction::{TransactionBuilder, TxBuilder, EVM};

/// Nanoseconds per UTC day, used to derive the current `day_index`.
const NANOS_PER_DAY: u64 = 86_400_000_000_000;

/// Gas attached to the outbound MPC `sign` call.
const SIGN_GAS: Gas = Gas::from_tgas(300);
/// Gas reserved for the `on_sign` callback.
const ON_SIGN_GAS: Gas = Gas::from_tgas(50);
/// MPC `sign` deposit: 0.05 NEAR in yoctoNEAR.
const SIGN_DEPOSIT_YOCTO: u128 = 50_000_000_000_000_000_000_000;

/// EVM chain id: Sepolia.
const CHAIN_ID_SEPOLIA: u64 = 11_155_111;
/// Hard cap on total transaction fees (max fee × gas limit), in wei.
const MAX_FEE_WEI: u128 = 5_000_000_000_000_000;

/// Unique storage prefixes, one variant per collection.
#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Policies,
    SpendWindows,
    Allowlist,
    AuditLog,
}

/// The `agentfence` contract state.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    /// Account that owns the fence and sets policies.
    pub owner: AccountId,
    /// The Chain Signatures MPC contract (e.g. `v1.signer-prod.testnet`).
    pub mpc_account: AccountId,
    /// Spend policies keyed by agent account.
    policies: IterableMap<AccountId, Policy>,
    /// Spend windows keyed by agent account.
    spend_windows: IterableMap<AccountId, SpendWindow>,
    /// Allowed `"<agent_id>|<destination>"` pairs.
    allowlist: LookupSet<String>,
    /// Append-only audit log.
    audit_log: Vector<AuditEntry>,
}

#[near]
impl Contract {
    /// Initialize a new fence owned by `owner`, using `mpc_account` for
    /// Chain Signatures.
    #[init]
    pub fn new(owner: AccountId, mpc_account: AccountId) -> Self {
        Self {
            owner,
            mpc_account,
            policies: IterableMap::new(StorageKey::Policies),
            spend_windows: IterableMap::new(StorageKey::SpendWindows),
            allowlist: LookupSet::new(StorageKey::Allowlist),
            audit_log: Vector::new(StorageKey::AuditLog),
        }
    }

    /// Panic with a clear message unless the caller is the owner.
    fn require_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner may call this method"
        );
    }

    /// Allowlist key for an agent/destination pair.
    fn allowlist_key(agent_id: &AccountId, destination: &str) -> String {
        format!("{agent_id}|{destination}")
    }

    /// Parse `"evm:0x"` + 40 hex chars into a 20-byte address.
    fn parse_destination(destination: &str) -> Option<[u8; 20]> {
        let hex = destination.strip_prefix("evm:0x")?;
        if hex.len() != 40 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        Some(parse_eth_address(hex))
    }

    /// Build the unsigned EVM (Sepolia) transaction and its keccak256
    /// signing hash. Pure: no state change. Returns `None` for a malformed
    /// destination.
    fn build_unsigned_tx(
        destination: &str,
        amount: U128,
        nonce: u64,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
        gas_limit: u64,
    ) -> Option<(Vec<u8>, Vec<u8>)> {
        let to = Self::parse_destination(destination)?;
        let tx = TransactionBuilder::new::<EVM>()
            .chain_id(CHAIN_ID_SEPOLIA)
            .nonce(nonce)
            .to(to)
            .value(amount.0)
            .input(vec![])
            .max_fee_per_gas(max_fee_per_gas.0)
            .max_priority_fee_per_gas(max_priority_fee_per_gas.0)
            .gas_limit(gas_limit as u128)
            .build();
        // EIP-1559: unsigned bytes = signing preimage, hash = keccak256.
        let unsigned = tx.build_for_signing();
        let hash = env::keccak256(&unsigned);
        Some((unsigned, hash))
    }

    // ------------------------------------------------------- admin (owner-only)
    // -------------------------------------------------------

    /// Create or update the spend policy for `agent_id`.
    ///
    /// Keeps the existing `paused` value on update; defaults to `false` on
    /// create. Requires `0 < per_tx_limit <= daily_cap`.
    pub fn set_policy(&mut self, agent_id: AccountId, per_tx_limit: U128, daily_cap: U128) {
        self.require_owner();
        require!(per_tx_limit.0 > 0, "per_tx_limit must be greater than 0");
        require!(
            per_tx_limit.0 <= daily_cap.0,
            "per_tx_limit must not exceed daily_cap"
        );

        let paused = self.policies.get(&agent_id).map(|p| p.paused).unwrap_or(false);
        self.policies.insert(
            agent_id,
            Policy {
                per_tx_limit,
                daily_cap,
                paused,
            },
        );
    }

    /// Allow `agent_id` to send to `destination`.
    pub fn add_destination(&mut self, agent_id: AccountId, destination: String) {
        self.require_owner();
        self.allowlist
            .insert(Self::allowlist_key(&agent_id, &destination));
    }

    /// Remove `destination` from `agent_id`'s allowlist.
    pub fn remove_destination(&mut self, agent_id: AccountId, destination: String) {
        self.require_owner();
        self.allowlist
            .remove(&Self::allowlist_key(&agent_id, &destination));
    }

    /// Pause or unpause an agent. Panics if the agent has no policy.
    pub fn set_paused(&mut self, agent_id: AccountId, paused: bool) {
        self.require_owner();
        let mut policy = self
            .policies
            .get(&agent_id)
            .cloned()
            .expect("agent has no policy");
        policy.paused = paused;
        self.policies.insert(agent_id, policy);
    }

    // ---------------------------------------------------------- spend requests
    // ----------------------------------------------------------

    /// Request a spend of `amount` to `destination` on behalf of the caller.
    ///
    /// The agent is always the predecessor account — there is intentionally
    /// no `agent_id` parameter, so one agent can never use another agent's
    /// policy. This never panics for a policy violation: a blocked request
    /// returns [`Decision::Blocked`] with an immediate value and still writes
    /// an audit entry (a panic would revert state and the `Blocked` entry
    /// would be lost).
    ///
    /// An allowed request reserves the spend, writes the audit entry, then
    /// asks the MPC contract to sign a payload derived from this request.
    /// The signature (or a refund of the reservation) is delivered through
    /// [`Self::on_sign`].
    #[allow(clippy::too_many_arguments)]
    pub fn request_spend(
        &mut self,
        destination: String,
        amount: U128,
        nonce: u64,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
        gas_limit: u64,
    ) -> PromiseOrValue<SpendResult> {
        let agent_id = env::predecessor_account_id();
        let day_index = env::block_timestamp() / NANOS_PER_DAY;

        // Spent so far today; a stale window counts as zero.
        let spent_today: u128 = match self.spend_windows.get(&agent_id) {
            Some(window) if window.day_index == day_index => window.spent.0,
            _ => 0,
        };

        // Checked in order; stop at the first failure. The fee cap is last
        // and is only reached when every earlier check passed.
        let fee_reason: Option<&str> = match max_fee_per_gas.0.checked_mul(gas_limit as u128) {
            Some(fee) if fee <= MAX_FEE_WEI => None,
            _ => Some("fee exceeds max_fee_cap"),
        };

        // Check in order; stop at the first failure.
        let blocked_reason: Option<&str> = match self.policies.get(&agent_id).cloned() {
            None => Some("no policy for agent"),
            Some(policy) => {
                if policy.paused {
                    Some("agent is paused")
                } else if amount.0 == 0 {
                    Some("amount must be greater than zero")
                } else if !self
                    .allowlist
                    .contains(&Self::allowlist_key(&agent_id, &destination))
                {
                    Some("destination not allowlisted")
                } else if Self::parse_destination(&destination).is_none() {
                    Some("invalid destination format")
                } else if amount.0 > policy.per_tx_limit.0 {
                    Some("exceeds per_tx_limit")
                } else {
                    match spent_today.checked_add(amount.0) {
                        Some(new_total) if new_total <= policy.daily_cap.0 => None,
                        _ => Some("exceeds daily_cap"), // over cap, or overflow
                    }
                }
            }
        };
        let blocked_reason = blocked_reason.or(fee_reason);

        match blocked_reason {
            Some(reason) => {
                self.record_audit(
                    &agent_id,
                    &destination,
                    amount,
                    Decision::Blocked,
                    Some(reason.to_string()),
                );
                PromiseOrValue::Value(SpendResult {
                    decision: Decision::Blocked,
                    reason: Some(reason.to_string()),
                    signature: None,
                    payload_hash: None,
                    unsigned_tx: None,
                })
            }
            None => {
                // Reserve the spend (window was validated above, so this
                // add cannot overflow) and record the allowed decision.
                let audit_id = self.audit_log.len() as u64;
                let new_spent = spent_today.saturating_add(amount.0);
                self.spend_windows.insert(
                    agent_id.clone(),
                    SpendWindow {
                        day_index,
                        spent: U128(new_spent),
                    },
                );
                self.record_audit(&agent_id, &destination, amount, Decision::Allowed, None);

                // The transaction is built here: `to`/`value`/`chain_id` /
                // `data` cannot be influenced beyond the policy-checked
                // destination and amount. Only nonce/fees/gas are agent
                // supplied, and fees are capped above.
                let (unsigned, hash) = Self::build_unsigned_tx(
                    &destination,
                    amount,
                    nonce,
                    max_fee_per_gas,
                    max_priority_fee_per_gas,
                    gas_limit,
                )
                .expect("destination was validated above");
                let payload_hash = hex_bytes(&hash);
                let unsigned_tx = hex_bytes(&unsigned);
                let path = format!("evm-sepolia-{agent_id}");
                let sign_args = near_sdk::serde_json::json!({
                    "request": {
                        "path": path,
                        "payload_v2": { "Ecdsa": payload_hash.clone() },
                        "domain_id": 0,
                    }
                });
                let callback_args = near_sdk::serde_json::json!({
                    "agent_id": agent_id.to_string(),
                    "amount": amount.0.to_string(),
                    "day_index": day_index,
                    "audit_id": audit_id,
                    "payload_hash": payload_hash,
                    "unsigned_tx": unsigned_tx,
                });

                let mpc_account = self.mpc_account.clone();
                PromiseOrValue::Promise(
                    Promise::new(mpc_account)
                        .function_call(
                            "sign",
                            sign_args.to_string().into_bytes(),
                            NearToken::from_yoctonear(SIGN_DEPOSIT_YOCTO),
                            SIGN_GAS,
                        )
                        .then(
                            Promise::new(env::current_account_id()).function_call(
                                "on_sign",
                                callback_args.to_string().into_bytes(),
                                NearToken::from_yoctonear(0),
                                ON_SIGN_GAS,
                            ),
                        ),
                )
            }
        }
    }

    /// Chain Signatures callback for an allowed spend.
    ///
    /// On success returns the MPC signature. On failure refunds the daily
    /// reservation (when the stored window is still for `day_index`) and
    /// appends a `Blocked` audit entry.
    #[private]
    pub fn on_sign(
        &mut self,
        agent_id: AccountId,
        amount: U128,
        day_index: u64,
        audit_id: u64,
        payload_hash: String,
        unsigned_tx: String,
        #[callback_result] result: Result<SignResult, PromiseError>,
    ) -> SpendResult {
        match result {
            Ok(signature) => SpendResult {
                decision: Decision::Allowed,
                reason: None,
                signature: Some(signature),
                payload_hash: Some(payload_hash),
                unsigned_tx: Some(unsigned_tx),
            },
            Err(_) => {
                if let Some(window) = self.spend_windows.get(&agent_id).cloned() {
                    if window.day_index == day_index {
                        let refunded = window.spent.0.saturating_sub(amount.0);
                        self.spend_windows.insert(
                            agent_id.clone(),
                            SpendWindow {
                                day_index: window.day_index,
                                spent: U128(refunded),
                            },
                        );
                    }
                }
                let destination = self
                    .audit_log
                    .iter()
                    .find(|entry| entry.id == audit_id)
                    .map(|entry| entry.destination.clone())
                    .unwrap_or_default();
                let reason = "sign failed, spend refunded".to_string();
                self.record_audit(
                    &agent_id,
                    &destination,
                    amount,
                    Decision::Blocked,
                    Some(reason.clone()),
                );
                SpendResult {
                    decision: Decision::Blocked,
                    reason: Some(reason),
                    signature: None,
                    payload_hash: Some(payload_hash),
                    unsigned_tx: Some(unsigned_tx),
                }
            }
        }
    }

    /// Append an audit entry for a spend request and log the decision.
    fn record_audit(
        &mut self,
        agent_id: &AccountId,
        destination: &str,
        amount: U128,
        decision: Decision,
        reason: Option<String>,
    ) {
        let id = self.audit_log.len() as u64;
        let timestamp = env::block_timestamp();
        env::log_str(&format!(
            "request_spend decision={decision:?} agent_id={agent_id} destination={destination} amount={} reason={reason:?}",
            amount.0
        ));
        self.audit_log.push(AuditEntry {
            id,
            timestamp,
            agent_id: agent_id.clone(),
            destination: destination.to_string(),
            amount,
            decision,
            reason,
        });
    }

    // ------------------------------------------------------------- views
    // -------------------------------------------------------------

    /// The spend policy for `agent_id`, if one is set.
    pub fn get_policy(&self, agent_id: AccountId) -> Option<Policy> {
        self.policies.get(&agent_id).cloned()
    }

    /// Whether `agent_id` may send to `destination`.
    pub fn is_destination_allowed(&self, agent_id: AccountId, destination: String) -> bool {
        self.allowlist
            .contains(&Self::allowlist_key(&agent_id, &destination))
    }

    /// Amount `agent_id` has spent today; 0 if no window or the day changed.
    pub fn get_spent_today(&self, agent_id: AccountId) -> U128 {
        let day_index = env::block_timestamp() / NANOS_PER_DAY;
        match self.spend_windows.get(&agent_id) {
            Some(window) if window.day_index == day_index => window.spent,
            _ => U128(0),
        }
    }

    /// Audit entries starting at `from_index`, up to `limit` of them.
    pub fn get_audit_log(&self, from_index: u64, limit: u64) -> Vec<AuditEntry> {
        self.audit_log
            .iter()
            .skip(from_index as usize)
            .take(limit as usize)
            .cloned()
            .collect()
    }

    /// The account that owns the fence.
    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    /// The Chain Signatures MPC contract.
    pub fn get_mpc_account(&self) -> AccountId {
        self.mpc_account.clone()
    }

    /// Hex keccak256 signing hash for a prospective transaction, without
    /// any state change. `None` for a malformed destination.
    #[allow(clippy::too_many_arguments)]
    pub fn preview_payload(
        &self,
        destination: String,
        amount: U128,
        nonce: u64,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
        gas_limit: u64,
    ) -> Option<String> {
        Self::build_unsigned_tx(
            &destination,
            amount,
            nonce,
            max_fee_per_gas,
            max_priority_fee_per_gas,
            gas_limit,
        )
        .map(|(_, hash)| hex_bytes(&hash))
    }
}

/// Lowercase hex encoding without pulling in a dependency.
fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn ctx(predecessor: &str) {
        ctx_at(predecessor, 0);
    }

    fn ctx_at(predecessor: &str, block_timestamp: u64) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id("fence.near".parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap())
            .block_timestamp(block_timestamp);
        testing_env!(builder.build());
    }

    /// Build a fence with `predecessor` as the current caller.
    fn fence_as(predecessor: &str) -> Contract {
        ctx(predecessor);
        Contract::new(
            "owner.near".parse().unwrap(),
            "v1.signer-prod.testnet".parse().unwrap(),
        )
    }

    /// The happy path: the owner is the caller.
    fn fence() -> Contract {
        fence_as("owner.near")
    }

    /// Unwrap a `Blocked` immediate result, panicking otherwise.
    fn unwrap_value(result: PromiseOrValue<SpendResult>) -> SpendResult {
        match result {
            PromiseOrValue::Value(value) => value,
            PromiseOrValue::Promise(_) => panic!("expected an immediate result, got a promise"),
        }
    }

    /// Assert an allowed result is the MPC promise chain.
    fn assert_promise(result: &PromiseOrValue<SpendResult>) {
        assert!(
            matches!(result, PromiseOrValue::Promise(_)),
            "expected the MPC promise chain"
        );
    }

    const EVM_DEST: &str = "evm:0x1111111111111111111111111111111111111111";

    /// Call `request_spend` with sane default tx parameters.
    fn spend(c: &mut Contract, dest: String, amount: u128) -> PromiseOrValue<SpendResult> {
        c.request_spend(dest, U128(amount), 0, U128(1_000_000_000), U128(0), 21_000)
    }

    fn account(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    #[test]
    fn only_owner_can_call_admin_methods() {
        let agent = account("agent.near");

        // set_policy
        let mut c = fence_as("attacker.near");
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.set_policy(agent.clone(), U128(10), U128(100));
        }));
        assert!(r.is_err(), "non-owner must not set_policy");

        // add_destination
        let mut c = fence_as("attacker.near");
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.add_destination(agent.clone(), "dest.near".to_string());
        }));
        assert!(r.is_err(), "non-owner must not add_destination");

        // remove_destination
        let mut c = fence_as("attacker.near");
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.remove_destination(agent.clone(), "dest.near".to_string());
        }));
        assert!(r.is_err(), "non-owner must not remove_destination");

        // set_paused (needs an existing policy, so create one as owner first)
        let mut c = fence();
        c.set_policy(agent.clone(), U128(10), U128(100));
        ctx("attacker.near");
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.set_paused(agent.clone(), true);
        }));
        assert!(r.is_err(), "non-owner must not set_paused");
    }

    #[test]
    fn set_policy_rejects_invalid_limits() {
        let mut c = fence();
        let agent = account("agent.near");

        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.set_policy(agent.clone(), U128(0), U128(100));
        }));
        assert!(r.is_err(), "per_tx_limit == 0 must be rejected");

        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.set_policy(agent.clone(), U128(101), U128(100));
        }));
        assert!(r.is_err(), "per_tx_limit > daily_cap must be rejected");

        assert!(c.get_policy(agent).is_none());
    }

    #[test]
    fn add_and_remove_destination() {
        let mut c = fence();
        let agent = account("agent.near");
        let dest = EVM_DEST.to_string();

        assert!(!c.is_destination_allowed(agent.clone(), dest.clone()));
        c.add_destination(agent.clone(), dest.clone());
        assert!(c.is_destination_allowed(agent.clone(), dest.clone()));
        c.remove_destination(agent.clone(), dest.clone());
        assert!(!c.is_destination_allowed(agent.clone(), dest.clone()));
    }

    #[test]
    fn set_paused_toggles_and_panics_for_unknown_agent() {
        let mut c = fence();
        let agent = account("agent.near");

        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.set_paused(account("unknown.near"), true);
        }));
        assert!(r.is_err(), "set_paused must panic for an agent with no policy");

        c.set_policy(agent.clone(), U128(10), U128(100));
        assert!(!c.get_policy(agent.clone()).unwrap().paused);
        c.set_paused(agent.clone(), true);
        assert!(c.get_policy(agent.clone()).unwrap().paused);
        c.set_paused(agent.clone(), false);
        assert!(!c.get_policy(agent.clone()).unwrap().paused);
    }

    #[test]
    fn get_spent_today_is_zero_for_new_agent() {
        let c = fence();
        assert_eq!(c.get_spent_today(account("newbie.near")), U128(0));
    }

    /// Day-3 timestamp used as "today" by the `request_spend` tests, so the
    /// day-rollover test can advance by exactly one day.
    const T: u64 = NANOS_PER_DAY * 3;

    /// Owner creates a fence, a policy for `agent`, and one allowlisted
    /// destination. Must be called while the owner is the predecessor.
    fn setup_agent(c: &mut Contract, agent: &AccountId, per_tx: u128, daily: u128, dest: &str) {
        c.set_policy(agent.clone(), U128(per_tx), U128(daily));
        c.add_destination(agent.clone(), dest.to_string());
    }

    #[test]
    fn allowed_spend_increases_spent_and_audits() {
        let mut c = fence();
        let agent = account("agent.near");
        let dest = EVM_DEST.to_string();
        setup_agent(&mut c, &agent, 100, 1000, &dest);

        ctx_at("agent.near", T);
        let result = spend(&mut c, dest.clone(), 50);

        assert_promise(&result);
        assert_eq!(c.get_spent_today(agent.clone()), U128(50));
        let log = c.get_audit_log(0, 10);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].id, 0);
        assert_eq!(log[0].agent_id, agent);
        assert_eq!(log[0].destination, dest);
        assert_eq!(log[0].amount, U128(50));
        assert_eq!(log[0].decision, Decision::Allowed);
        assert_eq!(log[0].reason, None);
    }

    #[test]
    fn over_per_tx_limit_is_blocked() {
        let mut c = fence();
        let agent = account("agent.near");
        let dest = EVM_DEST.to_string();
        setup_agent(&mut c, &agent, 100, 1000, &dest);

        ctx_at("agent.near", T);
        let value = unwrap_value(spend(&mut c, dest.clone(), 101));

        assert_eq!(value.decision, Decision::Blocked);
        assert_eq!(value.reason.as_deref(), Some("exceeds per_tx_limit"));
        assert_eq!(c.get_spent_today(agent.clone()), U128(0));
        let log = c.get_audit_log(0, 10);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].decision, Decision::Blocked);
        assert_eq!(log[0].reason.as_deref(), Some("exceeds per_tx_limit"));
    }

    #[test]
    fn non_allowlisted_destination_is_blocked() {
        let mut c = fence();
        let agent = account("agent.near");
        setup_agent(&mut c, &agent, 100, 1000, "dest.near");

        ctx_at("agent.near", T);
        let value = unwrap_value(spend(&mut c, "stranger.near".to_string(), 10));

        assert_eq!(value.decision, Decision::Blocked);
        assert_eq!(c.get_spent_today(agent.clone()), U128(0));
        let log = c.get_audit_log(0, 10);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].reason.as_deref(), Some("destination not allowlisted"));
    }

    #[test]
    fn paused_agent_is_blocked() {
        let mut c = fence();
        let agent = account("agent.near");
        let dest = EVM_DEST.to_string();
        setup_agent(&mut c, &agent, 100, 1000, &dest);
        c.set_paused(agent.clone(), true);

        ctx_at("agent.near", T);
        let value = unwrap_value(spend(&mut c, dest.clone(), 10));

        assert_eq!(value.decision, Decision::Blocked);
        assert_eq!(c.get_spent_today(agent.clone()), U128(0));
        let log = c.get_audit_log(0, 10);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].reason.as_deref(), Some("agent is paused"));
    }

    #[test]
    fn agent_with_no_policy_is_blocked_without_panicking() {
        let mut c = fence();
        ctx_at("agent.near", T);
        // No policy was ever set: must return Blocked, not panic.
        let value = unwrap_value(spend(&mut c, "dest.near".to_string(), 10));

        assert_eq!(value.decision, Decision::Blocked);
        assert_eq!(c.get_spent_today(account("agent.near")), U128(0));
        let log = c.get_audit_log(0, 10);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].reason.as_deref(), Some("no policy for agent"));
    }

    #[test]
    fn two_spends_together_exceeding_daily_cap_second_is_blocked() {
        let mut c = fence();
        let agent = account("agent.near");
        let dest = EVM_DEST.to_string();
        setup_agent(&mut c, &agent, 100, 150, &dest);

        ctx_at("agent.near", T);
        assert_promise(&spend(&mut c, dest.clone(), 100));
        assert_eq!(
            unwrap_value(spend(&mut c, dest.clone(), 100)).decision,
            Decision::Blocked
        );
        assert_eq!(c.get_spent_today(agent.clone()), U128(100));

        let log = c.get_audit_log(0, 10);
        assert_eq!(log.len(), 2);
        assert_eq!(log[1].id, 1);
        assert_eq!(log[1].reason.as_deref(), Some("exceeds daily_cap"));
    }

    #[test]
    fn zero_amount_is_blocked() {
        let mut c = fence();
        let agent = account("agent.near");
        let dest = EVM_DEST.to_string();
        setup_agent(&mut c, &agent, 100, 1000, &dest);

        ctx_at("agent.near", T);
        let value = unwrap_value(spend(&mut c, dest.clone(), 0));

        assert_eq!(value.decision, Decision::Blocked);
        assert_eq!(c.get_spent_today(agent.clone()), U128(0));
        let log = c.get_audit_log(0, 10);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].reason.as_deref(), Some("amount must be greater than zero"));
    }

    #[test]
    fn daily_window_resets_after_one_day() {
        let mut c = fence();
        let agent = account("agent.near");
        let dest = EVM_DEST.to_string();
        setup_agent(&mut c, &agent, 100, 100, &dest);

        ctx_at("agent.near", T);
        assert_promise(&spend(&mut c, dest.clone(), 100));
        assert_eq!(
            unwrap_value(spend(&mut c, dest.clone(), 1)).decision,
            Decision::Blocked
        );
        assert_eq!(c.get_spent_today(agent.clone()), U128(100));

        // One day later the window has reset.
        ctx_at("agent.near", T + NANOS_PER_DAY);
        assert_eq!(c.get_spent_today(agent.clone()), U128(0));
        assert_promise(&spend(&mut c, dest.clone(), 100));
        assert_eq!(c.get_spent_today(agent.clone()), U128(100));
    }

    #[test]
    fn agent_a_cannot_use_agent_bs_policy() {
        let mut c = fence();
        let agent_b = account("agent-b.near");
        let dest = EVM_DEST.to_string();
        setup_agent(&mut c, &agent_b, 10_000, 100_000, &dest);

        // Agent A (no policy) asks B's allowlisted destination.
        ctx_at("agent-a.near", T);
        let value = unwrap_value(spend(&mut c, dest.clone(), 10));

        assert_eq!(value.decision, Decision::Blocked);
        assert_eq!(c.get_spent_today(account("agent-a.near")), U128(0));
        assert_eq!(c.get_spent_today(agent_b.clone()), U128(0));
        let log = c.get_audit_log(0, 10);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].agent_id, account("agent-a.near"));
        assert_eq!(log[0].reason.as_deref(), Some("no policy for agent"));
    }

    #[test]
    fn on_sign_err_refunds_and_audits_blocked() {
        let mut c = fence();
        let agent = account("agent.near");
        let dest = EVM_DEST.to_string();
        setup_agent(&mut c, &agent, 100, 1000, &dest);

        ctx_at("agent.near", T);
        assert_promise(&spend(&mut c, dest.clone(), 50));
        assert_eq!(c.get_spent_today(agent.clone()), U128(50));

        // The callback runs with the contract itself as predecessor.
        ctx_at("fence.near", T);
        let result = c.on_sign(
            agent.clone(),
            U128(50),
            T / NANOS_PER_DAY,
            0,
            "hash".to_string(),
            "tx".to_string(),
            Err(PromiseError::Failed),
        );

        assert_eq!(result.decision, Decision::Blocked);
        assert_eq!(
            result.reason.as_deref(),
            Some("sign failed, spend refunded")
        );
        assert_eq!(result.signature, None);
        assert_eq!(c.get_spent_today(agent.clone()), U128(0));

        let log = c.get_audit_log(0, 10);
        assert_eq!(log.len(), 2);
        assert_eq!(log[1].id, 1);
        assert_eq!(log[1].decision, Decision::Blocked);
        assert_eq!(
            log[1].reason.as_deref(),
            Some("sign failed, spend refunded")
        );
        assert_eq!(log[1].destination, dest);
    }

    #[test]
    fn on_sign_ok_returns_signature_spent_unchanged() {
        let mut c = fence();
        let agent = account("agent.near");
        let dest = EVM_DEST.to_string();
        setup_agent(&mut c, &agent, 100, 1000, &dest);

        ctx_at("agent.near", T);
        assert_promise(&spend(&mut c, dest.clone(), 50));

        ctx_at("fence.near", T);
        let signature = SignResult {
            big_r: audit::AffinePoint {
                affine_point: "02cfa6".to_string(),
            },
            s: audit::Scalar {
                scalar: "56f85e".to_string(),
            },
            recovery_id: 1,
        };
        let result = c.on_sign(
            agent.clone(),
            U128(50),
            T / NANOS_PER_DAY,
            0,
            "hash".to_string(),
            "tx".to_string(),
            Ok(signature.clone()),
        );

        assert_eq!(result.decision, Decision::Allowed);
        assert_eq!(result.reason, None);
        assert_eq!(result.signature, Some(signature));
        assert_eq!(c.get_spent_today(agent.clone()), U128(50));
        assert_eq!(c.get_audit_log(0, 10).len(), 1);
    }

    #[test]
    fn preview_payload_is_deterministic() {
        let c = fence();
        let args = (
            EVM_DEST.to_string(),
            U128(50),
            7u64,
            U128(1_000_000_000),
            U128(1_000_000_000),
            21_000u64,
        );
        let a = c
            .preview_payload(
                args.0.clone(),
                args.1,
                args.2,
                args.3,
                args.4,
                args.5,
            )
            .unwrap();
        let b = c
            .preview_payload(args.0, args.1, args.2, args.3, args.4, args.5)
            .unwrap();
        assert_eq!(a, b);
        assert_eq!(a.len(), 64, "keccak256 hex should be 64 chars");
    }

    #[test]
    fn preview_payload_changes_with_each_field() {
        let c = fence();
        let base = c
            .preview_payload(
                EVM_DEST.to_string(),
                U128(50),
                7,
                U128(1_000_000_000),
                U128(1_000_000_000),
                21_000,
            )
            .unwrap();

        let dest_changed = c
            .preview_payload(
                "evm:0x2222222222222222222222222222222222222222".to_string(),
                U128(50),
                7,
                U128(1_000_000_000),
                U128(1_000_000_000),
                21_000,
            )
            .unwrap();
        assert_ne!(base, dest_changed);

        let amount_changed = c
            .preview_payload(
                EVM_DEST.to_string(),
                U128(51),
                7,
                U128(1_000_000_000),
                U128(1_000_000_000),
                21_000,
            )
            .unwrap();
        assert_ne!(base, amount_changed);

        let nonce_changed = c
            .preview_payload(
                EVM_DEST.to_string(),
                U128(50),
                8,
                U128(1_000_000_000),
                U128(1_000_000_000),
                21_000,
            )
            .unwrap();
        assert_ne!(base, nonce_changed);
    }

    #[test]
    fn malformed_destination_is_blocked_and_spends_nothing() {
        let mut c = fence();
        let agent = account("agent.near");
        let malformed = "evm:0xZZZ".to_string();
        setup_agent(&mut c, &agent, 100, 1000, &malformed);

        ctx_at("agent.near", T);
        let value = unwrap_value(spend(&mut c, malformed, 50));

        assert_eq!(value.decision, Decision::Blocked);
        assert_eq!(
            value.reason.as_deref(),
            Some("invalid destination format")
        );
        assert_eq!(c.get_spent_today(agent.clone()), U128(0));
        let log = c.get_audit_log(0, 10);
        assert_eq!(log.len(), 1);
        assert_eq!(
            log[0].reason.as_deref(),
            Some("invalid destination format")
        );
    }

    #[test]
    fn excessive_fee_is_blocked_and_spends_nothing() {
        let mut c = fence();
        let agent = account("agent.near");
        setup_agent(&mut c, &agent, 100, 1000, EVM_DEST);

        ctx_at("agent.near", T);
        // 10_000 gwei * 21_000 gas = 2.1e17 wei > 5e15 cap.
        let value = unwrap_value(c.request_spend(
            EVM_DEST.to_string(),
            U128(50),
            0,
            U128(10_000_000_000_000),
            U128(0),
            21_000,
        ));

        assert_eq!(value.decision, Decision::Blocked);
        assert_eq!(value.reason.as_deref(), Some("fee exceeds max_fee_cap"));
        assert_eq!(c.get_spent_today(agent.clone()), U128(0));
        let log = c.get_audit_log(0, 10);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].reason.as_deref(), Some("fee exceeds max_fee_cap"));
    }
}
