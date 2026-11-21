//! Instruction modules. Each module owns its account structs and handler.

pub mod admin_transfer;
pub mod initialize_config;
pub mod pause;
pub mod update_authorities;

pub use admin_transfer::{AcceptAdmin, ProposeAdmin};
pub use initialize_config::InitializeConfig;
pub use pause::{PauseProgram, UnpauseProgram};
pub use update_authorities::UpdateAuthorities;
