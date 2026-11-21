//! `propose_admin` / `accept_admin` — two-step admin handover.
//!
//! The admin key controls the configuration and may lift a pause, so handing
//! it over must never be a single call that can point at a typo or a key the
//! operator does not control: a one-call transfer would brick the registry.
//! The current admin nominates; the nominee has to sign to take the role.
//!
//! Distinctness is checked at both ends. The executor or pause authority may
//! rotate between proposal and acceptance, so the invariants are re-verified
//! against the live config at acceptance, not only at proposal time.

use anchor_lang::prelude::*;

use crate::{
    constants::{CONFIG_SEED, CONFIG_VERSION},
    error::FlashboltError,
    state::{AdminTransferred, AdminTransferProposed, Config},
};

#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// The current admin. Checked in the handler so the refusal carries a
    /// program error instead of a generic constraint failure.
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// The nominated key. Must match `config.pending_admin`.
    pub pending_admin: Signer<'info>,
}

pub fn propose(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require_keys_eq!(
        ctx.accounts.admin.key(),
        config.admin,
        FlashboltError::UnauthorizedAdmin
    );
    require!(
        config.version == CONFIG_VERSION,
        FlashboltError::UnsupportedConfigVersion
    );
    require!(new_admin != Pubkey::default(), FlashboltError::InvalidAuthority);
    require!(
        new_admin != config.admin,
        FlashboltError::AuthoritiesNotIndependent
    );
    require!(
        new_admin != config.executor && new_admin != config.pause_authority,
        FlashboltError::AuthoritiesNotIndependent
    );

    config.pending_admin = new_admin;
    emit!(AdminTransferProposed {
        admin: config.admin,
        pending_admin: new_admin,
    });

    Ok(())
}

pub fn accept(ctx: Context<AcceptAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let pending_admin = ctx.accounts.pending_admin.key();

    require!(
        config.pending_admin != Pubkey::default(),
        FlashboltError::NoPendingAdmin
    );
    require_keys_eq!(
        pending_admin,
        config.pending_admin,
        FlashboltError::UnauthorizedPendingAdmin
    );
    require!(
        config.version == CONFIG_VERSION,
        FlashboltError::UnsupportedConfigVersion
    );
    // Re-check against the live config: an authority may have rotated onto
    // this key while the proposal was waiting.
    require!(
        pending_admin != config.executor && pending_admin != config.pause_authority,
        FlashboltError::AuthoritiesNotIndependent
    );

    let previous_admin = config.admin;
    config.admin = pending_admin;
    config.pending_admin = Pubkey::default();

    emit!(AdminTransferred {
        previous_admin,
        admin: config.admin,
    });

    Ok(())
}
