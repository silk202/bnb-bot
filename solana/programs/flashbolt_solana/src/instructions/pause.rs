//! `pause_program` / `unpause_program` — asymmetric emergency controls.
//!
//! Pausing is deliberately easy: the pause authority **or** the admin can
//! stop execution immediately. Lifting the pause is admin-only, so a
//! compromised pause key cannot re-enable trading.
//!
//! Two deliberate asymmetries, both load-bearing:
//!
//! 1. **Role before state.** Both handlers check the signer's role before they
//!    look at `config.paused`. An unauthorized caller is refused for the role
//!    (6000/6001) whether or not a pause is in effect, so the refusal never
//!    varies with — and never leaks — the pause state.
//! 2. **Neither handler checks `version`.** An emergency stop must work on a
//!    configuration this build does not recognise; gating it on the schema
//!    would leave a program stuck running. Unpause is version-agnostic for the
//!    same reason in reverse: `Config::execution_allowed` already refuses to
//!    authorise execution on an unknown version, so lifting a pause cannot
//!    enable anything the schema does not allow, whereas a version gate here
//!    could make a paused account unrecoverable after a bad migration.

use anchor_lang::prelude::*;

use crate::{
    constants::CONFIG_SEED,
    error::FlashboltError,
    state::{Config, ProgramPaused, ProgramUnpaused},
};

#[derive(Accounts)]
pub struct PauseProgram<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// The pause authority or the admin.
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UnpauseProgram<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// The configured admin.
    pub admin: Signer<'info>,
}

pub fn pause(ctx: Context<PauseProgram>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let authority = ctx.accounts.authority.key();

    require!(
        authority == config.admin || authority == config.pause_authority,
        FlashboltError::UnauthorizedPauseAuthority
    );
    require!(!config.paused, FlashboltError::ProgramPaused);

    config.paused = true;
    emit!(ProgramPaused { authority });

    Ok(())
}

pub fn unpause(ctx: Context<UnpauseProgram>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require_keys_eq!(
        ctx.accounts.admin.key(),
        config.admin,
        FlashboltError::UnauthorizedAdmin
    );
    require!(config.paused, FlashboltError::ProgramNotPaused);

    config.paused = false;
    emit!(ProgramUnpaused {
        admin: config.admin,
    });

    Ok(())
}
