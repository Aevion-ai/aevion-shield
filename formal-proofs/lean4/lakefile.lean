/-
  Aevion Formal Verification - Lean 4 Project Configuration

  This project contains mathematical proofs for:
  - N=3 Optimality theorem for LLM Byzantine consensus
  - FPC (Finite Provable Computation) composition theorems
  - Byzantine fault tolerance bounds
  - Resilience factor calculations

  Build: lake build
  Run: lake run verify

  Patent: US 63/896,282
  Copyright (c) 2026 Aevion LLC. All rights reserved.
-/

import Lake
open Lake DSL

package aevion_proofs

-- Main library (no external dependencies for standalone proofs)
@[default_target]
lean_lib Aevion where
  roots := #[`Aevion]
  globs := #[.submodules `Aevion]

-- Executable for running proofs
lean_exe verify where
  root := `Main
  supportInterpreter := true
