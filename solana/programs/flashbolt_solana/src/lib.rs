//! FlashBolt — Solana configuration and authority foundation.
//!
//! Milestone 1 of the on-chain program. This build intentionally contains
//! **no trading surface**: no counter, no swap CPI, no flash loan and no
//! execution instruction. The previous starter functionality is gone; what
//! remains is the configuration registry and the authorities that a later
//! execution instruction must check.
//!
//! Instruction surface:
//!
//! | Instruction | Who | Effect |
//! | --- | --- | --- |
//! | [`initialize_config`] | initial admin | create the singleton `Config` PDA |
//! | [`update_authorities`] | admin | rotate executor / pause authority |
//! | [`propose_admin`] | admin | nominate the next admin |
//! | [`accept_admin`] | nominated admin | complete the handshake |
//! | [`pause_program`] | pause authority **or** admin | stop execution |
//! | [`unpause_program`] | admin only | lift the pause |
//!
//! Nothing here signs on a user's behalf, swaps tokens or moves funds.

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use instructions::{
    AcceptAdmin, InitializeConfig, PauseProgram, ProposeAdmin, UnpauseProgram,
    UpdateAuthorities,
};

// `#[program]` emits `use crate::__client_accounts_<ix>::…` for every handler.
// Those modules are generated next to each `#[derive(Accounts)]` struct — here
// inside the instruction submodules — so re-export them at the crate root
// where the macro looks for them.
pub(crate) use instructions::admin_transfer::{
    __client_accounts_accept_admin, __client_accounts_propose_admin,
};
pub(crate) use instructions::initialize_config::__client_accounts_initialize_config;
pub(crate) use instructions::pause::{
    __client_accounts_pause_program, __client_accounts_unpause_program,
};
pub(crate) use instructions::update_authorities::__client_accounts_update_authorities;

// The CPI account modules are only referenced when the `cpi` feature is on.
#[cfg(feature = "cpi")]
pub(crate) use instructions::admin_transfer::{
    __cpi_client_accounts_accept_admin, __cpi_client_accounts_propose_admin,
};
#[cfg(feature = "cpi")]
pub(crate) use instructions::initialize_config::__cpi_client_accounts_initialize_config;
#[cfg(feature = "cpi")]
pub(crate) use instructions::pause::{
    __cpi_client_accounts_pause_program, __cpi_client_accounts_unpause_program,
};
#[cfg(feature = "cpi")]
pub(crate) use instructions::update_authorities::__cpi_client_accounts_update_authorities;

// Confirmed program address (2026-11-21). It is the public key of the
// deployment keypair held in project settings; that keypair is the only one
// that may deploy this program to this address.
// `scripts/solana-program-preflight.sh` refuses READY unless `declare_id!`,
// every `Anchor.toml` entry, the IDL `address` and the program keypair all
// agree on this value. (Plain comments, not `///`: rustdoc generates nothing
// for a macro invocation, and clippy rejects a doc comment there.)
declare_id!("82BPo27Cg6em3CqhZxsxX4F8ER6d5auu2vqWYeTXRSVd");

#[program]
pub mod flashbolt_solana {
    use super::*;

    /// Create the singleton configuration registry.
    ///
    /// The initial administrator signs and pays the rent. `executor` and
    /// `pause_authority` must be explicit, non-default and different from the
    /// admin and from each other.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        executor: Pubkey,
        pause_authority: Pubkey,
    ) -> Result<()> {
        instructions::initialize_config::handle(ctx, executor, pause_authority)
    }

    /// Rotate the executor and/or pause authority. Admin signature required;
    /// at least one authority must be supplied.
    pub fn update_authorities(
        ctx: Context<UpdateAuthorities>,
        executor: Option<Pubkey>,
        pause_authority: Option<Pubkey>,
    ) -> Result<()> {
        instructions::update_authorities::handle(ctx, executor, pause_authority)
    }

    /// Nominate the next admin. The current admin signs; nothing changes until
    /// the nominee calls `accept_admin`. A later proposal replaces this one.
    pub fn propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
        instructions::admin_transfer::propose(ctx, new_admin)
    }

    /// Complete the handshake. Only the nominated key may call this; it
    /// becomes the admin and the pending nomination is cleared.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::admin_transfer::accept(ctx)
    }

    /// Emergency pause. Callable by the pause authority or the admin.
    pub fn pause_program(ctx: Context<PauseProgram>) -> Result<()> {
        instructions::pause::pause(ctx)
    }

    /// Lift the pause. Only the admin may call this.
    pub fn unpause_program(ctx: Context<UnpauseProgram>) -> Result<()> {
        instructions::pause::unpause(ctx)
    }
}
