//! Policy types for `agentfence`.

use near_sdk::json_types::U128;
use near_sdk::near;

/// Human-authored spend policy for an agent.
///
/// Plain fields only — no collections nested inside it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    /// Maximum spend per transaction.
    pub per_tx_limit: U128,
    /// Maximum spend per day.
    pub daily_cap: U128,
    /// Whether the agent is paused (no spends allowed).
    pub paused: bool,
}

/// Rolling spend window tracking state for an agent.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpendWindow {
    /// Index of the UTC day this window covers.
    pub day_index: u64,
    /// Amount spent so far in that day.
    pub spent: U128,
}
