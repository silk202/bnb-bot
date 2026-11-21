//! `update_authorities` — rotate the executor and/or pause authority.
//!
//! Admin signature only. Admin transfer is deliberately not part of this
//! instruction: handing over the admin key must be an explicit two-step
//! handshake, not an accidental one-call transfer.

use anchor_lang::prelude::*;

use crate::{
    constants::CONFIG_SEED,
    error::FlashboltError,
    state::{AuthoritiesUpdated, Config},
};

#[derive(Accounts)]
pub struct UpdateAuthorities<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// Must be the configured admin. Checked in the handler so the refusal
    /// carries a program error instead of a generic constraint failure.
    pub admin: Signer<'info>,
}

pub fn handle(
    ctx: Context<UpdateAuthorities>,
    executor: Option<Pubkey>,
    pause_authority: Option<Pubkey>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    // Authorization comes first, before any argument inspection. A stranger
    // calling with no arguments must be told it lacks the role, not that the
    // call shape is wrong: the same rule `unpause` follows, and it keeps an
    // unauthorized caller from probing which inputs the program accepts.
    require_keys_eq!(
        ctx.accounts.admin.key(),
        config.admin,
        FlashboltError::UnauthorizedAdmin
    );

    require!(
        executor.is_some() || pause_authority.is_some(),
        FlashboltError::NoAuthorityChange
    );

    if let Some(executor) = executor {
        require!(
            executor != Pubkey::default(),
            FlashboltError::InvalidAuthority
        );
        config.executor = executor;
    }
    if let Some(pause_authority) = pause_authority {
        require!(
            pause_authority != Pubkey::default(),
            FlashboltError::InvalidAuthority
        );
        config.pause_authority = pause_authority;
    }

    require!(
        config.admin != config.executor
            && config.admin != config.pause_authority
            && config.executor != config.pause_authority,
        FlashboltError::AuthoritiesNotIndependent
    );

    emit!(AuthoritiesUpdated {
        admin: config.admin,
        executor: config.executor,
        pause_authority: config.pause_authority,
    });

    Ok(())
}
