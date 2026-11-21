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

/// Headroom at the end of `Config`, held as an always-zero `reserved` array.
///
/// The execution milestone will need configuration this build cannot name yet:
/// a lender program id, one or more venue program ids, fee and slippage
/// ceilings, a minimum-profit floor and their own version tag. Sizing the
/// account for today's seven fields would force a realloc (or a fresh account
/// and a migration instruction) the first time one of those lands.
///
/// 256 bytes covers four program ids (128), two token mints (64) and eight
/// fixed-width scalars, with slack. Rent on the difference is a few thousand
/// lamports, and changing it after the first deploy is no longer free.
///
/// A later schema version keeps this field **last** and reinterprets its tail
/// in place; that is why nothing may be appended after it.
pub const CONFIG_RESERVED_BYTES: usize = 256;

/// Serialized size of `Config`:
/// 8-byte Anchor discriminator + 4 × 32-byte keys (admin, executor, pause
/// authority, pending admin) + bool + bump + version + reserved headroom.
///
/// This is exact: the serializer writes every field, so the account is filled
/// to the last byte and `Config::reserved` is what a migration rewrites.
pub const CONFIG_ACCOUNT_SPACE: usize =
    8 + (32 * 4) + 1 + 1 + 1 + CONFIG_RESERVED_BYTES;
