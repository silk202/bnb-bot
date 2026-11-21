//! Seeds, account size and the configuration schema version.

/// Seed of the singleton configuration PDA — `[b"flashbolt_config"]`.
pub const CONFIG_SEED: &[u8] = b"flashbolt_config";

/// Schema version this build writes into `Config::version`. The program has
/// never been deployed, so the schema still grows in place at version `1`;
/// bump this only once a deployed account has to be migrated.
///
/// Bump this only together with a migration; `Config::execution_allowed`
/// refuses a version it does not know.
pub const CONFIG_VERSION: u8 = 1;

/// Serialized size of `Config`:
/// 8-byte Anchor discriminator + 4 × 32-byte keys (admin, executor, pause
/// authority, pending admin) + bool + bump + version.
pub const CONFIG_ACCOUNT_SPACE: usize = 8 + (32 * 4) + 1 + 1 + 1;
