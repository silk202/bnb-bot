//! LiteSVM tests for the FlashBolt configuration and authority foundation.
//!
//! Covers initialization, authority separation, admin-only rotation, the
//! asymmetric pause/unpause rule and the removal of the previous starter
//! instructions. Every test runs against the compiled program in a local VM.

use flashbolt_config_tests::*;
use solana_sdk::{pubkey::Pubkey, signature::Keypair, signer::Signer};

/// Three distinct funded-ish actors: admin, executor, pause authority.
struct Actors {
    admin: Keypair,
    executor: Keypair,
    pause_authority: Keypair,
}

impl Actors {
    fn new() -> Self {
        Self {
            admin: Keypair::new(),
            executor: Keypair::new(),
            pause_authority: Keypair::new(),
        }
    }
}

fn initialized() -> (Harness, Actors) {
    let actors = Actors::new();
    let mut harness = Harness::new();
    harness
        .initialize(
            &actors.admin,
            actors.executor.pubkey(),
            actors.pause_authority.pubkey(),
        )
        .expect("initialize_config");
    (harness, actors)
}

#[test]
fn initialize_writes_the_configuration_registry() {
    let (harness, actors) = initialized();
    let config = harness.config();

    assert_eq!(config.admin, actors.admin.pubkey());
    assert_eq!(config.executor, actors.executor.pubkey());
    assert_eq!(config.pause_authority, actors.pause_authority.pubkey());
    assert!(!config.paused);
    assert_eq!(config.version, 1);
    assert_eq!(config.reserved, [0u8; CONFIG_RESERVED_BYTES]);

    let (pda, bump) = Pubkey::find_program_address(&[CONFIG_SEED], &id());
    assert_eq!(config.bump, bump);
    assert!(harness.account_exists(&pda));
}

#[test]
fn config_reserves_headroom_for_the_execution_milestone() {
    let (harness, _) = initialized();
    let config = harness.config();

    // The reserve exists so the execution milestone's configuration (lender and
    // venue program ids, fee/slippage ceilings, minimum profit) lands in this
    // account instead of forcing a realloc after the first deploy.
    assert_eq!(config.reserved.len(), CONFIG_RESERVED_BYTES);
    assert_eq!(CONFIG_RESERVED_BYTES, 256);
    assert!(
        config.reserved.iter().all(|byte| *byte == 0),
        "version 1 must leave the reservation zeroed"
    );

    // Size is exact: discriminator + four keys + bool + bump + version +
    // reserve. `Harness::config` already asserts the on-chain length matches.
    assert_eq!(CONFIG_ACCOUNT_SPACE, 8 + (32 * 4) + 3 + CONFIG_RESERVED_BYTES);
}

#[test]
fn initialize_rejects_a_default_authority() {
    let admin = Keypair::new();
    let mut harness = Harness::new();

    let err = harness
        .initialize(&admin, Pubkey::default(), Keypair::new().pubkey())
        .expect_err("a default executor must be refused");
    assert_anchor_error(err, FlashboltError::InvalidAuthority);

    let err = harness
        .initialize(&admin, Keypair::new().pubkey(), Pubkey::default())
        .expect_err("a default pause authority must be refused");
    assert_anchor_error(err, FlashboltError::InvalidAuthority);
}

#[test]
fn initialize_requires_three_independent_authorities() {
    let admin = Keypair::new();
    let mut harness = Harness::new();

    let err = harness
        .initialize(&admin, admin.pubkey(), Keypair::new().pubkey())
        .expect_err("admin and executor must differ");
    assert_anchor_error(err, FlashboltError::AuthoritiesNotIndependent);

    let pause = Keypair::new().pubkey();
    let err = harness
        .initialize(&admin, pause, pause)
        .expect_err("executor and pause authority must differ");
    assert_anchor_error(err, FlashboltError::AuthoritiesNotIndependent);

    let err = harness
        .initialize(&admin, Keypair::new().pubkey(), admin.pubkey())
        .expect_err("admin and pause authority must differ");
    assert_anchor_error(err, FlashboltError::AuthoritiesNotIndependent);
}

#[test]
fn config_can_only_be_initialized_once() {
    let (mut harness, actors) = initialized();
    let second_admin = Keypair::new();

    let result = harness.initialize(
        &second_admin,
        Keypair::new().pubkey(),
        Keypair::new().pubkey(),
    );
    assert!(result.is_err(), "re-initialization must be refused");
    assert_eq!(harness.config().admin, actors.admin.pubkey());
}

#[test]
fn admin_rotates_executor_and_pause_authority() {
    let (mut harness, actors) = initialized();
    let new_executor = Keypair::new().pubkey();
    let new_pause = Keypair::new().pubkey();

    harness
        .update_authorities(&actors.admin, Some(new_executor), Some(new_pause))
        .expect("admin rotation");

    let config = harness.config();
    assert_eq!(config.executor, new_executor);
    assert_eq!(config.pause_authority, new_pause);
    assert_eq!(config.admin, actors.admin.pubkey(), "admin must not change");
}

#[test]
fn update_rejects_a_non_admin_signer() {
    let (mut harness, actors) = initialized();
    let stranger = Keypair::new();

    let err = harness
        .update_authorities(&stranger, Some(stranger.pubkey()), None)
        .expect_err("a stranger must not rotate authorities");
    assert_anchor_error(err, FlashboltError::UnauthorizedAdmin);
    assert_eq!(harness.config().executor, actors.executor.pubkey());
}

#[test]
fn update_requires_at_least_one_change() {
    let (mut harness, actors) = initialized();

    let err = harness
        .update_authorities(&actors.admin, None, None)
        .expect_err("an empty update must be refused");
    assert_anchor_error(err, FlashboltError::NoAuthorityChange);
}

#[test]
fn update_denies_strangers_before_checking_arguments() {
    let (mut harness, actors) = initialized();
    let stranger = Keypair::new();

    // Role first: a stranger sending an empty update is refused for the role,
    // exactly like a stranger sending a real one, and gets no hint that the
    // empty shape is itself invalid.
    let err = harness
        .update_authorities(&stranger, None, None)
        .expect_err("a stranger must be refused for the role");
    assert_anchor_error(err, FlashboltError::UnauthorizedAdmin);

    harness.expire_blockhash();
    let err = harness
        .update_authorities(&actors.admin, None, None)
        .expect_err("the admin still gets the argument error");
    assert_anchor_error(err, FlashboltError::NoAuthorityChange);
}

#[test]
fn update_cannot_collapse_authorities_onto_one_key() {
    let (mut harness, actors) = initialized();

    let err = harness
        .update_authorities(&actors.admin, Some(actors.pause_authority.pubkey()), None)
        .expect_err("executor must not become the pause authority");
    assert_anchor_error(err, FlashboltError::AuthoritiesNotIndependent);

    let err = harness
        .update_authorities(&actors.admin, Some(Pubkey::default()), None)
        .expect_err("a default executor must be refused");
    assert_anchor_error(err, FlashboltError::InvalidAuthority);
}

#[test]
fn pause_authority_can_pause_but_cannot_unpause() {
    let (mut harness, actors) = initialized();

    harness
        .pause(&actors.pause_authority)
        .expect("pause authority pauses");
    assert!(harness.config().paused);

    let err = harness
        .unpause(&actors.pause_authority)
        .expect_err("pause authority must not unpause");
    assert_anchor_error(err, FlashboltError::UnauthorizedAdmin);
    assert!(harness.config().paused, "the pause must still hold");

    harness.unpause(&actors.admin).expect("admin unpauses");
    assert!(!harness.config().paused);
}

#[test]
fn admin_can_pause_and_strangers_cannot() {
    let (mut harness, actors) = initialized();

    let stranger = Keypair::new();
    let err = harness
        .pause(&stranger)
        .expect_err("a stranger must not pause");
    assert_anchor_error(err, FlashboltError::UnauthorizedPauseAuthority);
    assert!(!harness.config().paused);

    harness.pause(&actors.admin).expect("admin pauses");
    assert!(harness.config().paused);
}

#[test]
fn pause_is_refused_when_already_paused() {
    let (mut harness, actors) = initialized();
    harness.pause(&actors.pause_authority).expect("pause");

    // A fresh blockhash, so the identical retry is a new transaction rather
    // than a duplicate signature the runtime would reject as AlreadyProcessed.
    harness.expire_blockhash();

    let err = harness
        .pause(&actors.pause_authority)
        .expect_err("a second pause must be refused");
    assert_anchor_error(err, FlashboltError::ProgramPaused);
}

#[test]
fn unpause_is_refused_when_not_paused() {
    let (mut harness, actors) = initialized();

    let err = harness
        .unpause(&actors.admin)
        .expect_err("unpause without a pause must be refused");
    assert_anchor_error(err, FlashboltError::ProgramNotPaused);
}

#[test]
fn execution_predicate_tracks_pause_and_executor() {
    let (mut harness, actors) = initialized();
    let stranger = Keypair::new().pubkey();

    let config = harness.config();
    assert!(config.execution_allowed(&actors.executor.pubkey()));
    assert!(!config.execution_allowed(&stranger));
    assert!(!config.execution_allowed(&actors.admin.pubkey()));

    harness.pause(&actors.pause_authority).expect("pause");
    assert!(!harness.config().execution_allowed(&actors.executor.pubkey()));
}

#[test]
fn admin_transfer_requires_the_nominee_to_accept() {
    let (mut harness, actors) = initialized();
    let successor = Keypair::new();

    harness
        .propose_admin(&actors.admin, successor.pubkey())
        .expect("admin proposes a successor");

    let config = harness.config();
    assert_eq!(config.admin, actors.admin.pubkey(), "still the old admin");
    assert_eq!(config.pending_admin, successor.pubkey());
    assert!(config.has_pending_admin());

    harness
        .accept_admin(&successor)
        .expect("the nominee accepts");

    let config = harness.config();
    assert_eq!(config.admin, successor.pubkey());
    assert_eq!(config.pending_admin, Pubkey::default());
    assert!(!config.has_pending_admin());
}

#[test]
fn former_admin_loses_authority_after_the_handover() {
    let (mut harness, actors) = initialized();
    let successor = Keypair::new();

    harness
        .propose_admin(&actors.admin, successor.pubkey())
        .expect("propose");
    harness.accept_admin(&successor).expect("accept");
    harness.expire_blockhash();

    let err = harness
        .update_authorities(&actors.admin, Some(Keypair::new().pubkey()), None)
        .expect_err("the former admin must not rotate authorities");
    assert_anchor_error(err, FlashboltError::UnauthorizedAdmin);

    let err = harness
        .propose_admin(&actors.admin, Keypair::new().pubkey())
        .expect_err("the former admin must not propose a successor");
    assert_anchor_error(err, FlashboltError::UnauthorizedAdmin);

    // Authorization is checked before the pause state, so the refusal names the
    // lost role rather than the (also true) "not paused".
    let err = harness
        .unpause(&actors.admin)
        .expect_err("the former admin must not unpause");
    assert_anchor_error(err, FlashboltError::UnauthorizedAdmin);
}

#[test]
fn accept_rejects_a_signer_that_was_not_nominated() {
    let (mut harness, actors) = initialized();
    let successor = Keypair::new();
    let stranger = Keypair::new();

    harness
        .propose_admin(&actors.admin, successor.pubkey())
        .expect("propose");

    let err = harness
        .accept_admin(&stranger)
        .expect_err("a stranger must not take the admin role");
    assert_anchor_error(err, FlashboltError::UnauthorizedPendingAdmin);
    assert_eq!(harness.config().admin, actors.admin.pubkey());
    assert_eq!(harness.config().pending_admin, successor.pubkey());
}

#[test]
fn accept_without_a_proposal_is_refused() {
    let (mut harness, _actors) = initialized();
    let claimant = Keypair::new();

    let err = harness
        .accept_admin(&claimant)
        .expect_err("there is nothing to accept");
    assert_anchor_error(err, FlashboltError::NoPendingAdmin);
}

#[test]
fn propose_rejects_default_self_and_current_authorities() {
    let (mut harness, actors) = initialized();

    let err = harness
        .propose_admin(&actors.admin, Pubkey::default())
        .expect_err("a default successor must be refused");
    assert_anchor_error(err, FlashboltError::InvalidAuthority);

    let err = harness
        .propose_admin(&actors.admin, actors.admin.pubkey())
        .expect_err("the current admin must not be re-nominated");
    assert_anchor_error(err, FlashboltError::AuthoritiesNotIndependent);

    let err = harness
        .propose_admin(&actors.admin, actors.executor.pubkey())
        .expect_err("the executor must not also become admin");
    assert_anchor_error(err, FlashboltError::AuthoritiesNotIndependent);

    let err = harness
        .propose_admin(&actors.admin, actors.pause_authority.pubkey())
        .expect_err("the pause authority must not also become admin");
    assert_anchor_error(err, FlashboltError::AuthoritiesNotIndependent);

    assert!(!harness.config().has_pending_admin());
}

#[test]
fn accept_rechecks_independence_after_a_rotation() {
    let (mut harness, actors) = initialized();
    let successor = Keypair::new();

    harness
        .propose_admin(&actors.admin, successor.pubkey())
        .expect("propose");
    // The admin makes the nominee the executor while the handshake is pending.
    harness
        .update_authorities(&actors.admin, Some(successor.pubkey()), None)
        .expect("rotation");

    let err = harness
        .accept_admin(&successor)
        .expect_err("one key must not hold executor and admin");
    assert_anchor_error(err, FlashboltError::AuthoritiesNotIndependent);
    assert_eq!(harness.config().admin, actors.admin.pubkey());
}

#[test]
fn removed_starter_instructions_are_gone() {
    let (mut harness, actors) = initialized();

    for legacy in ["initialize", "increment", "close"] {
        let ix = removed_instruction_ix(legacy);
        assert!(
            harness.send_raw(ix).is_err(),
            "the removed `{legacy}` instruction must not exist"
        );
    }

    // No state beyond the Config PDA was created.
    assert!(!harness.account_exists(&actors.executor.pubkey()));
}
