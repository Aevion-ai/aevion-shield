//! # Aevion Formal Verification Library
//!
//! Machine-checked proofs for Byzantine AI consensus using Verus and Prusti.
//!
//! ## Modules
//!
//! - `variance_halt`: Variance-based Byzantine detection proofs
//! - `trust_bounds`: Trust score preservation proofs
//! - `byzantine_consensus`: Core BFT theorems
//! - `ed25519_contracts`: Cryptographic operation contracts
//!
//! ## Verification Commands
//!
//! ```bash
//! # Verus proofs
//! verus src/variance_halt.rs
//! verus src/trust_bounds.rs
//! verus src/byzantine_consensus.rs
//!
//! # Prusti contracts
//! cargo prusti
//!
//! # Standard tests
//! cargo test
//! ```
//!
//! ## Patent: US 63/896,282
//!
//! This library provides formal verification evidence for:
//! - Claim 2: N=3 Optimality
//! - Claim 3: Constitutional Halts
//! - Claim 4: Hardware-Attested Consensus
//! - Claims 16-17: Byzantine Threshold
//! - Claims 79-82: Formal Verification (CIP)
//!
//! Copyright (c) 2026 Aevion LLC. All rights reserved.

#![allow(unused)]

// NOTE: Verus proof files (variance_halt.rs, trust_bounds.rs, etc.) are standalone
// verification files. They are NOT compiled as Rust modules.
//
// To verify proofs, use the `verus` command:
//   verus src/variance_halt.rs
//   verus src/trust_bounds.rs
//   verus src/byzantine_consensus.rs
//   verus src/ed25519_contracts.rs
//
// These files use Verus-specific syntax (verus! macro, vstd) that is not
// valid standard Rust. They exist as formal specifications, not runtime code.

/// Library version
pub const VERSION: &str = "0.1.0";

/// Verification status
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerificationStatus {
    /// All proofs verified successfully
    Verified,
    /// Some proofs pending
    Partial,
    /// Verification failed
    Failed,
}

/// Summary of verification results
#[derive(Debug)]
pub struct VerificationSummary {
    pub variance_halt: VerificationStatus,
    pub trust_bounds: VerificationStatus,
    pub byzantine_consensus: VerificationStatus,
    pub ed25519_contracts: VerificationStatus,
}

impl VerificationSummary {
    /// Create a new summary (all pending initially)
    pub fn new() -> Self {
        Self {
            variance_halt: VerificationStatus::Partial,
            trust_bounds: VerificationStatus::Partial,
            byzantine_consensus: VerificationStatus::Partial,
            ed25519_contracts: VerificationStatus::Partial,
        }
    }

    /// Check if all modules are verified
    pub fn all_verified(&self) -> bool {
        self.variance_halt == VerificationStatus::Verified
            && self.trust_bounds == VerificationStatus::Verified
            && self.byzantine_consensus == VerificationStatus::Verified
            && self.ed25519_contracts == VerificationStatus::Verified
    }

    /// Get overall status
    pub fn overall(&self) -> VerificationStatus {
        if self.all_verified() {
            VerificationStatus::Verified
        } else if self.variance_halt == VerificationStatus::Failed
            || self.trust_bounds == VerificationStatus::Failed
            || self.byzantine_consensus == VerificationStatus::Failed
            || self.ed25519_contracts == VerificationStatus::Failed
        {
            VerificationStatus::Failed
        } else {
            VerificationStatus::Partial
        }
    }
}

impl Default for VerificationSummary {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version() {
        assert_eq!(VERSION, "0.1.0");
    }

    #[test]
    fn test_verification_summary() {
        let mut summary = VerificationSummary::new();
        assert_eq!(summary.overall(), VerificationStatus::Partial);

        summary.variance_halt = VerificationStatus::Verified;
        summary.trust_bounds = VerificationStatus::Verified;
        summary.byzantine_consensus = VerificationStatus::Verified;
        summary.ed25519_contracts = VerificationStatus::Verified;
        assert_eq!(summary.overall(), VerificationStatus::Verified);
        assert!(summary.all_verified());
    }
}
