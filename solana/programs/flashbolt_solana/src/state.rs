//! Program state and events.
//!
//! There is exactly one [`Config`] account. It is the registry the future
//! execution instruction must read before it can do anything: who may execute,
//! whether the program is paused, and which schema version it was written with.

use anchor_lang::prelude::*;

use crate::constants::{CONFIG_RESERVED_BYTES, CONFIG_VERSION};

/// The singleton configuration registry.
///
/// Storing these authorities does **not** restrict execution by itself — the
/// execution instruction must check [`Config::execution_allowed`] (and later
/// the DEX/repayment rules) on chain. No such instruction exists in this
/// Milestone 1 build.
#[account]
pub struct Config {
    /// Controls configuration and authority management.
    pub admin: Pubkey,
    /// Authorized signer for arbitrage execution. Checked by the future
    /// execution instruction; nothing enforces it yet.
    pub executor: Pubkey,
    /// May activate the emergency pause. May **not** lift it.
    pub pause_authority: Pubkey,
    /// The key the admin has nominated to take over, or the default address
    /// while no handshake is in flight. It has no powers until it calls
    /// `accept_admin`.
    pub pending_admin: Pubkey,
    /// Blocks execution while true.
    pub paused: bool,
    /// PDA derivation bump.
    pub bump: u8,
    /// Configuration schema version.
    pub version: u8,
    /// Reserved headroom, always zero in version `1`.
    ///
    /// The execution milestone's configuration (lender and venue program ids,
    /// fee/slippage ceilings, a minimum-profit floor) lands here instead of
    /// forcing an account realloc. It must stay the **last** field: a later
    /// version reinterprets this tail in place, so appending after it would
    /// move the boundary for every existing account.
    pub reserved: [u8; CONFIG_RESERVED_BYTES],
}

impl Config {
    /// The predicate an execution instruction must satisfy before it may run.
    ///
    /// Kept on the account so the rule lives in one place. It is exposed for
    /// the future instruction and for off-chain checks; it enforces nothing on
    /// chain until that instruction calls it.
    pub fn execution_allowed(&self, executor: &Pubkey) -> bool {
        !self.paused && self.version == CONFIG_VERSION && self.executor == *executor
    }

    /// Whether an admin handshake is waiting for the nominee to accept.
    pub fn has_pending_admin(&self) -> bool {
        self.pending_admin != Pubkey::default()
    }
}

/// Emitted once, when the registry is created.
#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub executor: Pubkey,
    pub pause_authority: Pubkey,
    pub version: u8,
}

/// Emitted whenever the admin rotates an authority.
#[event]
pub struct AuthoritiesUpdated {
    pub admin: Pubkey,
    pub executor: Pubkey,
    pub pause_authority: Pubkey,
}

/// Emitted when the admin nominates a successor.
#[event]
pub struct AdminTransferProposed {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
}

/// Emitted when the nominee accepts and becomes the admin. The previous admin
/// has no authority from this point on.
#[event]
pub struct AdminTransferred {
    pub previous_admin: Pubkey,
    pub admin: Pubkey,
}

/// Emitted when execution is paused.
#[event]
pub struct ProgramPaused {
    /// The signer that paused: the pause authority or the admin.
    pub authority: Pubkey,
}

/// Emitted when the admin lifts the pause.
#[event]
pub struct ProgramUnpaused {
    pub admin: Pubkey,
}
