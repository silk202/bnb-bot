//! Error codes for the configuration and authority instructions.
//!
//! Anchor numbers these from 6000 in declaration order. Keep existing variants
//! in place: their numbers are part of the program's external contract.

use anchor_lang::prelude::*;

#[error_code]
pub enum FlashboltError {
    #[msg("Only the configured admin may perform this action.")]
    UnauthorizedAdmin,

    #[msg("Only the configured pause authority or admin may pause the program.")]
    UnauthorizedPauseAuthority,

    #[msg("The program is paused; execution is blocked.")]
    ProgramPaused,

    #[msg("The program is not paused.")]
    ProgramNotPaused,

    #[msg("An authority address may not be the default address.")]
    InvalidAuthority,

    #[msg("Admin, executor and pause authority must be three distinct keys.")]
    AuthoritiesNotIndependent,

    #[msg("update_authorities needs at least one new authority.")]
    NoAuthorityChange,

    #[msg("The configuration schema version is not the one this build supports.")]
    UnsupportedConfigVersion,

    #[msg("No admin transfer is pending.")]
    NoPendingAdmin,

    #[msg("Only the nominated admin may accept the transfer.")]
    UnauthorizedPendingAdmin,
}
