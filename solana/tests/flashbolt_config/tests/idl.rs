//! IDL conformance: the tracked `solana/idl/flashbolt_solana.json` must
//! describe exactly the program that is in this workspace.
//!
//! `anchor idl build` regenerates the file from the same source, so this test
//! is a diff check that runs with the tests instead of in a separate CI step:
//! it re-derives every discriminator, and it compares the instruction,
//! argument, account, error, event and `Config` surfaces against the program.
//!
//! It fails rather than skips when the IDL is missing, for the same reason the
//! LiteSVM harness refuses to run without the compiled artifact.

use std::{fs, path::PathBuf};

use anchor_lang::solana_program::hash::hash;
use flashbolt_config_tests::{id, FlashboltError, CONFIG_RESERVED_BYTES, CONFIG_SEED};
use serde_json::{json, Value};

/// Instruction surface of this build, with each handler's argument names in
/// declaration order. An added or removed instruction must change this list
/// **and** regenerate the IDL; the test then proves the two agree.
const INSTRUCTIONS: [(&str, &[&str]); 6] = [
    ("initialize_config", &["executor", "pause_authority"]),
    ("update_authorities", &["executor", "pause_authority"]),
    ("propose_admin", &["new_admin"]),
    ("accept_admin", &[]),
    ("pause_program", &[]),
    ("unpause_program", &[]),
];

/// (instruction, the only account that may sign).
const SIGNERS: [(&str, &str); 6] = [
    ("initialize_config", "admin"),
    ("update_authorities", "admin"),
    ("propose_admin", "admin"),
    ("accept_admin", "pending_admin"),
    ("pause_program", "authority"),
    ("unpause_program", "admin"),
];

/// `FlashboltError` variants, in declaration order — Anchor numbers them from
/// 6000 in that order, and the numbers are the external contract.
const ERRORS: [FlashboltError; 10] = [
    FlashboltError::UnauthorizedAdmin,
    FlashboltError::UnauthorizedPauseAuthority,
    FlashboltError::ProgramPaused,
    FlashboltError::ProgramNotPaused,
    FlashboltError::InvalidAuthority,
    FlashboltError::AuthoritiesNotIndependent,
    FlashboltError::NoAuthorityChange,
    FlashboltError::UnsupportedConfigVersion,
    FlashboltError::NoPendingAdmin,
    FlashboltError::UnauthorizedPendingAdmin,
];

/// Every event the program declares, in `state.rs` order. The IDL list is
/// compared as a set, so this order is documentation rather than an assertion:
/// anchor does not guarantee the order it writes events in.
const EVENTS: [&str; 6] = [
    "ConfigInitialized",
    "AuthoritiesUpdated",
    "AdminTransferProposed",
    "AdminTransferred",
    "ProgramPaused",
    "ProgramUnpaused",
];

fn idl() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../idl/flashbolt_solana.json");
    let raw = fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "cannot read {}: {error} — generate it with \
             `cd solana && anchor idl build -o idl/flashbolt_solana.json`",
            path.display()
        )
    });
    serde_json::from_str(&raw)
        .unwrap_or_else(|error| panic!("{} is not valid JSON: {error}", path.display()))
}

/// Anchor's discriminator: `sha256("<prefix>:<name>")[..8]`.
fn discriminator(prefix: &str, name: &str) -> Value {
    json!(hash(format!("{prefix}:{name}").as_bytes()).to_bytes()[..8])
}

fn named<'a>(items: &'a Value, key: &str, name: &str) -> &'a Value {
    items
        .as_array()
        .unwrap_or_else(|| panic!("IDL `{key}` is not an array"))
        .iter()
        .find(|item| item["name"] == json!(name))
        .unwrap_or_else(|| panic!("IDL `{key}` has no `{name}`"))
}

fn names(items: &Value) -> Vec<String> {
    let mut names: Vec<String> = items
        .as_array()
        .expect("IDL list is an array")
        .iter()
        .map(|item| item["name"].as_str().expect("name is a string").to_string())
        .collect();
    names.sort();
    names
}

#[test]
fn idl_describes_the_declared_program() {
    let idl = idl();

    assert_eq!(
        idl["address"],
        json!(id().to_string()),
        "the tracked IDL addresses a different program than declare_id!"
    );
    assert_eq!(idl["metadata"]["name"], json!("flashbolt_solana"));
    assert_eq!(idl["metadata"]["version"], json!("0.1.0"));
}

#[test]
fn idl_lists_exactly_the_program_instructions_and_discriminators() {
    let idl = idl();
    let mut expected: Vec<String> = INSTRUCTIONS
        .iter()
        .map(|(name, _)| (*name).to_string())
        .collect();
    expected.sort();

    assert_eq!(names(&idl["instructions"]), expected);

    for (name, _) in INSTRUCTIONS {
        assert_eq!(
            named(&idl["instructions"], "instructions", name)["discriminator"],
            discriminator("global", name),
            "IDL discriminator for `{name}` does not match sha256(\"global:{name}\")"
        );
    }
}

#[test]
fn idl_instruction_arguments_match_the_handlers() {
    let idl = idl();

    for (name, args) in INSTRUCTIONS {
        let ix = named(&idl["instructions"], "instructions", name);
        let actual: Vec<&str> = ix["args"]
            .as_array()
            .expect("args is an array")
            .iter()
            .map(|arg| arg["name"].as_str().expect("arg name"))
            .collect();
        assert_eq!(actual, args, "argument list drifted for `{name}`");
    }

    // Types are part of the wire format: one Borsh byte for the `Option` tag,
    // then a 32-byte key only when it is `Some`.
    for (name, option) in [
        ("initialize_config", false),
        ("update_authorities", true),
    ] {
        let ix = named(&idl["instructions"], "instructions", name);
        for arg in ix["args"].as_array().expect("args") {
            let expected = if option {
                json!({ "option": "pubkey" })
            } else {
                json!("pubkey")
            };
            assert_eq!(arg["type"], expected, "argument type drifted for `{name}`");
        }
    }
}

#[test]
fn idl_accounts_pin_the_config_pda_and_the_only_signer() {
    let idl = idl();
    let seed_bytes = json!(CONFIG_SEED);

    for (name, signer) in SIGNERS {
        let ix = named(&idl["instructions"], "instructions", name);
        let accounts = ix["accounts"].as_array().expect("accounts is an array");

        let config = &accounts[0];
        assert_eq!(config["name"], json!("config"), "config must be first");
        assert_eq!(config["writable"], json!(true));
        assert_eq!(
            config["pda"]["seeds"][0],
            json!({ "kind": "const", "value": seed_bytes }),
            "`{name}` must derive `config` from the `flashbolt_config` seed"
        );

        let signers: Vec<&str> = accounts
            .iter()
            .filter(|account| account["signer"] == json!(true))
            .map(|account| account["name"].as_str().expect("account name"))
            .collect();
        assert_eq!(signers, vec![signer], "signer set drifted for `{name}`");
    }
}

#[test]
fn idl_errors_keep_their_codes_and_declaration_order() {
    let idl = idl();
    let errors = idl["errors"].as_array().expect("errors is an array");
    assert_eq!(errors.len(), ERRORS.len());

    for (index, variant) in ERRORS.iter().enumerate() {
        assert_eq!(
            errors[index]["code"],
            json!(6000 + index as u32),
            "error code drifted at position {index}"
        );
        assert_eq!(
            errors[index]["name"],
            json!(format!("{variant:?}")),
            "error name drifted at position {index}"
        );
    }
}

#[test]
fn idl_events_and_config_account_match_the_program() {
    let idl = idl();

    let mut expected = EVENTS.to_vec();
    expected.sort();
    assert_eq!(names(&idl["events"]), expected);
    for event in EVENTS {
        assert_eq!(
            named(&idl["events"], "events", event)["discriminator"],
            discriminator("event", event),
            "event discriminator for `{event}` does not match its name"
        );
    }

    let account = named(&idl["accounts"], "accounts", "Config");
    assert_eq!(
        account["discriminator"],
        discriminator("account", "Config")
    );

    let config = named(&idl["types"], "types", "Config");
    let fields: Vec<&str> = config["type"]["fields"]
        .as_array()
        .expect("Config fields")
        .iter()
        .map(|field| field["name"].as_str().expect("field name"))
        .collect();
    assert_eq!(
        fields,
        vec![
            "admin",
            "executor",
            "pause_authority",
            "pending_admin",
            "paused",
            "bump",
            "version",
            "reserved",
        ],
        "Config field order is part of the account layout"
    );

    // The reserve must be the last field and must be visible in the IDL, so a
    // future field cannot be appended after it unnoticed.
    assert_eq!(
        config["type"]["fields"][7]["type"],
        json!({ "array": ["u8", CONFIG_RESERVED_BYTES] })
    );
}
