import Aevion.NThreeOptimal
import Aevion.FPCComposition
import Aevion.ByzantineBounds
import Aevion.ResilienceFactor

/-!
# Aevion Formal Verification Library

Mathematical proofs for Byzantine AI consensus using Lean 4.

## Modules

- `Aevion.NThreeOptimal`: N=3 optimality theorem for LLM ensembles
- `Aevion.FPCComposition`: Finite Provable Computation composition theorems
- `Aevion.ByzantineBounds`: Byzantine fault tolerance bounds
- `Aevion.ResilienceFactor`: Resilience factor calculations

## Evidence Base

- 500-sample GSM8K benchmark (p < 0.001)
- Baseline accuracy: 92.8% (464/500)
- 33% attack accuracy: 83.0% (415/500)
- 67% attack halt rate: 57.8% (289/500)

## Patent: US 63/896,282

This library provides formal proof evidence for:
- Claim 2: N=3 Optimality
- Claim 3: Constitutional Halts
- Claims 79-82: Formal Verification (CIP)

Copyright (c) 2026 Aevion LLC. All rights reserved.
-/
