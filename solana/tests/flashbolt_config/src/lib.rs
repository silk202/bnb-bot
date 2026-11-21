//! LiteSVM harness for the FlashBolt configuration/authority program.
//!
//! The tests drive the compiled SBF artifact directly. They never contact an
//! RPC, never use a funded key and never touch a cluster.
//!
//! Build the program first:
//!
//! ```text
//! cd solana && anchor build
//! cargo test -p flashbolt-config-tests -- --nocapture
//! ```

use std::path::Path;

use anchor_lang::{error::ERROR_CODE_OFFSET, solana_program::hash::hash, AccountDeserialize};
use litesvm::LiteSVM;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction, InstructionError},
    pubkey::Pubkey,
    signature::Keypair,
    signer::Signer,
    transaction::{Transaction, TransactionError},
};

pub use flashbolt_solana::{
    constants::{CONFIG_ACCOUNT_SPACE, CONFIG_SEED},
    error::FlashboltError,
    id,
    state::Config,
};

/// Compiled program produced by `anchor build`.
pub const PROGRAM_SO: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/flashbolt_solana.so"
);

/// The singleton configuration PDA.
pub fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &id()).0
}

/// Anchor instruction discriminator: `sha256("global:<name>")[..8]`.
pub fn discriminator(name: &str) -> Vec<u8> {
    let digest = hash(format!("global:{name}").as_bytes()).to_bytes();
    digest[..8].to_vec()
}

fn borsh_option_pubkey(value: Option<Pubkey>) -> Vec<u8> {
    match value {
        Some(key) => {
            let mut out = Vec::with_capacity(33);
            out.push(1);
            out.extend_from_slice(key.as_ref());
            out
        }
        None => vec![0],
    }
}

pub fn initialize_config_ix(
    admin: Pubkey,
    executor: Pubkey,
    pause_authority: Pubkey,
) -> Instruction {
    let mut data = discriminator("initialize_config");
    data.extend_from_slice(executor.as_ref());
    data.extend_from_slice(pause_authority.as_ref());

    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new(admin, true),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ],
        data,
    }
}

pub fn update_authorities_ix(
    admin: Pubkey,
    executor: Option<Pubkey>,
    pause_authority: Option<Pubkey>,
) -> Instruction {
    let mut data = discriminator("update_authorities");
    data.extend_from_slice(&borsh_option_pubkey(executor));
    data.extend_from_slice(&borsh_option_pubkey(pause_authority));

    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(admin, true),
        ],
        data,
    }
}

pub fn propose_admin_ix(admin: Pubkey, new_admin: Pubkey) -> Instruction {
    let mut data = discriminator("propose_admin");
    data.extend_from_slice(new_admin.as_ref());

    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(admin, true),
        ],
        data,
    }
}

pub fn accept_admin_ix(pending_admin: Pubkey) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(pending_admin, true),
        ],
        data: discriminator("accept_admin"),
    }
}

pub fn pause_program_ix(authority: Pubkey) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(authority, true),
        ],
        data: discriminator("pause_program"),
    }
}

pub fn unpause_program_ix(admin: Pubkey) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(admin, true),
        ],
        data: discriminator("unpause_program"),
    }
}

/// A program call that is no longer part of this build.
pub fn removed_instruction_ix(name: &str) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![AccountMeta::new_readonly(config_pda(), false)],
        data: discriminator(name),
    }
}

/// Credit a test account directly.
///
/// `LiteSVM::airdrop` signs with one fixed keypair and the same blockhash, so a
/// second airdrop in the same VM is rejected as `AlreadyProcessed`. Setting the
/// account is deterministic and repeatable.
fn credit(svm: &mut LiteSVM, key: &Pubkey, lamports: u64) {
    svm.set_account(
        *key,
        Account {
            lamports,
            data: Vec::new(),
            owner: solana_sdk::system_program::id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .expect("fund a test account");
}

pub struct Harness {
    pub svm: LiteSVM,
    payer: Keypair,
}

impl Default for Harness {
    fn default() -> Self {
        Self::new()
    }
}

impl Harness {
    /// Boot LiteSVM with the compiled program loaded. Panics with the build
    /// command when the artifact is missing — a skip would hide a real gap.
    pub fn new() -> Self {
        assert!(
            Path::new(PROGRAM_SO).exists(),
            "missing {PROGRAM_SO} — build the program first: (cd solana && anchor build)"
        );

        let mut svm = LiteSVM::new();
        if let Err(error) = svm.add_program_from_file(id(), PROGRAM_SO) {
            panic!("could not load {PROGRAM_SO}: {error:?}");
        }

        let payer = Keypair::new();
        credit(&mut svm, &payer.pubkey(), 100_000_000_000);

        Self { svm, payer }
    }

    /// Fund a test actor so it can pay fees and rent.
    pub fn fund(&mut self, key: &Pubkey) {
        credit(&mut self.svm, key, 10_000_000_000);
    }

    fn payer_keypair(&self) -> Keypair {
        Keypair::from_bytes(&self.payer.to_bytes()).expect("clone the test payer")
    }

    pub fn send(
        &mut self,
        fee_payer: &Keypair,
        signers: &[&Keypair],
        ix: Instruction,
    ) -> Result<(), TransactionError> {
        let blockhash = self.svm.latest_blockhash();
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&fee_payer.pubkey()),
            signers,
            blockhash,
        );
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|failed| failed.err)
    }

    pub fn initialize(
        &mut self,
        admin: &Keypair,
        executor: Pubkey,
        pause_authority: Pubkey,
    ) -> Result<(), TransactionError> {
        self.fund(&admin.pubkey());
        let ix = initialize_config_ix(admin.pubkey(), executor, pause_authority);
        self.send(admin, &[admin], ix)
    }

    pub fn update_authorities(
        &mut self,
        signer: &Keypair,
        executor: Option<Pubkey>,
        pause_authority: Option<Pubkey>,
    ) -> Result<(), TransactionError> {
        self.fund(&signer.pubkey());
        let ix = update_authorities_ix(signer.pubkey(), executor, pause_authority);
        self.send(signer, &[signer], ix)
    }

    pub fn propose_admin(
        &mut self,
        admin: &Keypair,
        new_admin: Pubkey,
    ) -> Result<(), TransactionError> {
        self.fund(&admin.pubkey());
        let ix = propose_admin_ix(admin.pubkey(), new_admin);
        self.send(admin, &[admin], ix)
    }

    pub fn accept_admin(&mut self, pending_admin: &Keypair) -> Result<(), TransactionError> {
        self.fund(&pending_admin.pubkey());
        let ix = accept_admin_ix(pending_admin.pubkey());
        self.send(pending_admin, &[pending_admin], ix)
    }

    pub fn pause(&mut self, authority: &Keypair) -> Result<(), TransactionError> {
        self.fund(&authority.pubkey());
        let ix = pause_program_ix(authority.pubkey());
        self.send(authority, &[authority], ix)
    }

    pub fn unpause(&mut self, signer: &Keypair) -> Result<(), TransactionError> {
        self.fund(&signer.pubkey());
        let ix = unpause_program_ix(signer.pubkey());
        self.send(signer, &[signer], ix)
    }

    /// Send a hand-built instruction with the harness payer as fee payer.
    pub fn send_raw(&mut self, ix: Instruction) -> Result<(), TransactionError> {
        let payer = self.payer_keypair();
        self.send(&payer, &[&payer], ix)
    }

    pub fn config(&self) -> Config {
        let account = self
            .svm
            .get_account(&config_pda())
            .expect("config account is missing");
        assert_eq!(
            account.owner,
            id(),
            "config account must be owned by the program"
        );
        assert_eq!(
            account.data.len(),
            CONFIG_ACCOUNT_SPACE,
            "config account size drifted from CONFIG_ACCOUNT_SPACE"
        );
        Config::try_deserialize(&mut account.data.as_slice())
            .expect("config account did not decode as Config")
    }

    pub fn account_exists(&self, key: &Pubkey) -> bool {
        self.svm.get_account(key).is_some()
    }

    /// Advance the blockhash so an identical retry gets a fresh signature
    /// instead of being rejected as `AlreadyProcessed` by the runtime.
    pub fn expire_blockhash(&mut self) {
        self.svm.expire_blockhash();
    }
}

/// Assert the transaction failed with a specific `FlashboltError`.
///
/// Anchor offsets program errors by [`ERROR_CODE_OFFSET`] (6000) in
/// declaration order of [`FlashboltError`].
pub fn assert_anchor_error(err: TransactionError, expected: FlashboltError) {
    match err {
        TransactionError::InstructionError(_, InstructionError::Custom(code)) => {
            let expected_code = ERROR_CODE_OFFSET + expected as u32;
            assert_eq!(
                code, expected_code,
                "expected {expected:?} ({expected_code}), got custom error {code}"
            );
        }
        other => panic!("expected an Anchor program error, got {other:?}"),
    }
}
