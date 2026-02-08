# Aevion Shield - Cloudflare Workers Fleet

Serverless verification infrastructure running on Cloudflare's edge network. Fourteen specialized Workers form a distributed proof pipeline with collective intelligence, cross-domain regulation tracking, CEO operations automation, and cryptographically verifiable AI inference.

**Patent**: US 63/896,282 - Constitutional Halt + Human Oversight

---

## Architecture Overview

```
                          Internet
                             |
          +------------------+------------------+
          |                  |                  |
   edge-sheriff         ai-sheriff        sentient-core
   (Ed25519 +           (Workers AI        (Workers AI
    Merkle)              inference)          sample)
          |                  |
          +--------+---------+
                   |
     +-------------+-------------+
     |             |             |
 proof-agent  vetproof-hitl  sentient-collective
 (Durable Obj  (Workflow +    (Master-agent +
  + x402 pay)  waitForEvent)  6 verticals +
     |             |           Quantum Shards)
     +------+------+             |
            |              regulation-tracker
     +------+------+       (Cron: every 6h,
     |             |        9 reg domains,
vetproof-workflow  vetproof-consensus  cross-domain
(6-step durable    (BFT Durable Obj    symbiosis)
 pipeline)          + Queue consumer)
```

---

## Worker Descriptions

### 1. edge-sheriff (`edge-sheriff.js`)
**Type**: Stateless Worker with KV + D1

Cryptographic verification at the edge. Validates Ed25519 signatures, verifies Merkle proof inclusion paths, and performs fast KV cache lookups before falling back to Workers AI inference.

| Feature | Detail |
|---------|--------|
| Signature verification | Ed25519 via WebCrypto `verify()` |
| Merkle proofs | Binary hash-path verification |
| Coherence scoring | Workers AI similarity check |
| Caching | KV namespace for proof lookups |
| Audit | D1 insert on every verification |

**Endpoints**: `/health`, `/v1/verify`, `/v1/quick-verify`, `/v1/proof/:id`

**Bindings**: `AI`, `VERIFICATION_CACHE` (KV), `AUDIT_DB` (D1)

---

### 2. ai-sheriff (`ai-sheriff.js`)
**Type**: Stateless Worker with Workers AI

AI-powered verification using Cloudflare's inference API. Supports single and batch verification, embedding generation, and cosine similarity scoring across multiple model tiers.

| Feature | Detail |
|---------|--------|
| Models | `@cf/meta/llama-3.1-8b-instruct` (fast), `@cf/qwen/qwen1.5-14b-chat-awq` (quality) |
| Embeddings | `@cf/baai/bge-base-en-v1.5` (768-dim) |
| Similarity | Cosine similarity between claim and evidence vectors |
| Batch mode | Up to 10 concurrent verifications |

**Endpoints**: `/health`, `/v1/verify`, `/v1/batch-verify`, `/v1/embeddings`

**Bindings**: `AI`, `VERIFICATION_CACHE` (KV)

---

### 3. proof-agent (`proof-agent.js`)
**Type**: Durable Object with SQLite + Alarms

The monetization and agent layer. Each `ProofAgent` is a stateful Durable Object with embedded SQLite for session persistence, WebSocket support for real-time state sync, scheduled tasks via the Alarm API, and x402 payment gating for premium verification tiers.

| Feature | Detail |
|---------|--------|
| State | SQLite (tasks, messages, verification results) |
| WebSocket | Real-time bidirectional state sync |
| x402 payment | HTTP 402 + `X-Payment` header for micropayments |
| Alarms | Scheduled background tasks (cleanup, retry) |
| Shield Consensus | Multi-model voting with variance halt |
| Proof signing | SHA-256 hash chain via WebCrypto |

**Endpoints**: `/health`, `/v1/agent/create`, `/v1/agent/:id/verify`, `/v1/agent/:id/ws`, `/v1/agent/:id/status`

**Bindings**: `PROOF_AGENT` (Durable Object), `AI`, `VERIFICATION_CACHE` (KV), `AUDIT_DB` (D1), `PROOF_STORAGE` (R2)

---

### 4. vetproof-hitl (`vetproof-hitl.js`)
**Type**: Cloudflare Workflow (WorkflowEntrypoint)

Human-in-the-loop approval gates for high-stakes claims using Cloudflare's durable Workflow API. When AI pre-screening detects low confidence or high risk, the workflow pauses via `step.waitForEvent()` until a human reviewer approves or rejects through the HTTP API.

| Feature | Detail |
|---------|--------|
| AI pre-screening | Workers AI claim analysis (completeness, risk flags) |
| Constitutional Halt | Confidence < 0.67 triggers mandatory human review |
| HITL gate | `waitForEvent()` pauses workflow up to 7 days |
| Auto-approve | Low-risk claims bypass human review |
| Proof signing | SHA-256 hash + R2 archival on approval |
| Audit trail | D1 insert at screening + decision stages |

**Pipeline**: Submit -> AI Screen -> Risk Assessment -> Audit -> HITL Gate -> Sign Proof -> Final Audit

**Endpoints**: `/health`, `/v1/claims/submit`, `/v1/claims/status/:id`, `/v1/claims/approve`, `/v1/claims/reject`, `/v1/claims/pending`, `/v1/proof/:claim_id`

**Bindings**: `HITL_WORKFLOW` (Workflow), `AI`, `VERIFICATION_CACHE` (KV), `AUDIT_DB` (D1), `PROOF_STORAGE` (R2)

---

### 5. vetproof-workflow (`vetproof-workflow.js`)
**Type**: Cloudflare Workflow (WorkflowEntrypoint)

Six-step durable verification pipeline with automatic retries and exponential backoff. Each step is independently recoverable.

| Step | Name | Description |
|------|------|-------------|
| 1 | SANITIZE | PII detection and redaction (regex-based) |
| 2 | EMBED | Generate 768-dim embeddings via `bge-base-en-v1.5` |
| 3 | SEARCH | Vectorize semantic search for relevant evidence |
| 4 | VERIFY | Multi-model BFT consensus verification |
| 5 | DETECT | Hallucination and consistency detection |
| 6 | SIGN | SHA-256 proof hash + R2 archival + D1 audit |

**Constitutional Halt**: If standard deviation of model agreement > 0.25, the claim is flagged for review rather than auto-approved.

**Endpoints**: `/health`, `/v1/pipeline/start`, `/v1/pipeline/status/:id`

**Bindings**: `VETPROOF_PIPELINE` (Workflow), `AI`, `EVIDENCE_INDEX` (Vectorize), `VERIFICATION_CACHE` (KV), `AUDIT_DB` (D1), `PROOF_STORAGE` (R2)

---

### 6. vetproof-consensus (`vetproof-consensus.js`)
**Type**: Durable Object + Queue Consumer

Stateful BFT consensus coordinator. Each `ShieldConsensus` Durable Object manages a voting session with embedded SQLite for vote storage, quorum tracking, and variance analysis. Also acts as a Queue consumer for async pipeline processing.

| Feature | Detail |
|---------|--------|
| BFT consensus | 2/3 supermajority quorum requirement |
| Variance halt | stdDev > 0.25 triggers Constitutional Halt |
| Models | 3 Workers AI models (llama-3.1-8b, qwen1.5-14b, bge-base-en-v1.5) |
| SQLite state | Vote records, session history, evidence cache |
| Queue consumer | 5-phase pipeline: SANITIZE/GENERATE/VERIFY/DETECT/SIGN |
| Vectorize | Evidence embedding and semantic search |
| Proof archival | R2 storage with custom metadata |

**Endpoints**: `/health`, `/v1/consensus/start`, `/v1/consensus/:id/vote`, `/v1/consensus/:id/status`, `/v1/evidence/embed`, `/v1/evidence/search`

**Bindings**: `SHIELD_CONSENSUS` (Durable Object), `AI`, `EVIDENCE_INDEX` (Vectorize), `VETPROOF_QUEUE` (Queue), `VERIFICATION_CACHE` (KV), `AUDIT_DB` (D1), `PROOF_STORAGE` (R2)

---

### 7. sentient-core
**Type**: Stateless Worker (dashboard-created)

Minimal Workers AI sample deployed via the Cloudflare dashboard. Serves as a health-check endpoint and baseline inference test.

---

### 8. sentient-collective (`sentient-collective.js`)
**Type**: Cloudflare Workflow (WorkflowEntrypoint) + Vectorize

Master-agent orchestrator implementing the SentientCore Collective Intelligence layer. Routes claims to domain-specialized vertical "slave" agents, extracts anonymized knowledge shards from verified claims, and enables safe cross-domain learning via Vectorize embeddings.

| Feature | Detail |
|---------|--------|
| Vertical agents | 6 domains: VetProof, Legal, Finance, Health, Education, Aviation |
| Per-vertical halt | VetProof 0.67, Legal 0.70, Finance 0.75, Health 0.80, Education 0.65, Aviation 0.85 |
| Quantum Shard Learning | PII-stripped knowledge fragments embedded in Vectorize |
| Domain-specific AI | Each vertical gets a tailored system prompt and model |
| Evidence Chain | SHA-256 proof hashing + R2 archival + D1 audit trail |
| NIST AI RMF | Compliant architecture with Constitutional Halt |

**Pipeline** (8 durable steps): Route -> Analyze -> Halt Check -> Extract Shards -> Store Shards -> Query Collective -> Audit -> Store Proof

**Endpoints**: `/health`, `/v1/verticals`, `/v1/collective/analyze`, `/v1/collective/status/:id`, `/v1/collective/knowledge`, `/v1/collective/stats`, `/v1/collective/proof/:id`

**Bindings**: `COLLECTIVE_WORKFLOW` (Workflow), `AI`, `VECTORIZE` (Vectorize), `VERIFICATION_CACHE` (KV), `RATE_LIMITS` (KV), `SESSIONS` (KV), `AUDIT_DB` (D1), `PROOF_STORAGE` (R2)

---

### 9. regulation-tracker (`regulation-tracker.js`)
**Type**: Scheduled (Cron) Worker + Vectorize

Living regulatory database that runs every 6 hours to check for regulatory changes across 9 domains and 6 verticals. Detects cross-domain impacts via a symbiosis map, embeds regulatory knowledge shards into Vectorize, and stores evidence in the proof locker.

| Feature | Detail |
|---------|--------|
| Cron schedule | `0 */6 * * *` (every 6 hours) |
| Regulatory domains | VA 38 CFR, HIPAA 45 CFR, FAA 14 CFR, SOX 17 CFR, FERPA 34 CFR, NIST AI RMF, EU AI Act, MN MCDPA, NIST PQC |
| Cross-domain symbiosis | 14 rules mapping cascading regulatory impacts |
| eCFR integration | Polls `ecfr.gov/api/versioner/v1/titles/{title}` for CFR version changes |
| Workers AI | Analyzes non-CFR sources (NIST, EU, state legislature) |
| Knowledge embedding | Regulatory shards stored in Vectorize for collective learning |

**Symbiosis examples**: HIPAA change -> impacts Health AND VetProof verticals. NIST AI RMF change -> impacts ALL verticals.

**Endpoints**: `/health`, `/v1/regulations`, `/v1/regulations/symbiosis`, `/v1/regulations/updates`, `/v1/regulations/check`, `/v1/regulations/impacts/:vertical`

**Bindings**: `AI`, `VECTORIZE` (Vectorize), `VERIFICATION_CACHE` (KV), `RATE_LIMITS` (KV), `AUDIT_DB` (D1), `PROOF_STORAGE` (R2)

---

## Cloudflare Primitives Used

| Primitive | Binding | Purpose |
|-----------|---------|---------|
| **Workers AI** | `AI` | LLM inference (Llama 3.1, Qwen 1.5), embeddings (BGE) |
| **KV** | `VERIFICATION_CACHE` | Proof cache, pending review queue |
| **KV** | `RATE_LIMITS` | Per-IP/per-key rate limiting |
| **KV** | `SESSIONS` | Authentication session storage |
| **D1** | `AUDIT_DB` | Verification proofs, audit events, rate limit logs |
| **R2** | `PROOF_STORAGE` | Immutable proof archival with metadata |
| **Durable Objects** | `PROOF_AGENT` | Stateful agent with SQLite, WebSocket, Alarms |
| **Durable Objects** | `SHIELD_CONSENSUS` | BFT voting coordinator with SQLite |
| **Workflows** | `HITL_WORKFLOW` | Durable HITL approval with `waitForEvent()` |
| **Workflows** | `VETPROOF_PIPELINE` | 6-step durable verification pipeline |
| **Vectorize** | `EVIDENCE_INDEX` | 768-dim semantic evidence search |
| **Queues** | `VETPROOF_QUEUE` | Async pipeline stage processing |
| **Workflows** | `COLLECTIVE_WORKFLOW` | 8-step collective orchestration pipeline |
| **Cron Triggers** | `0 */6 * * *` | Scheduled regulation tracking (every 6h) |

---

## Setup

### 1. Install Wrangler
```bash
npm install -g wrangler
wrangler login
```

### 2. Create Resources
```bash
# KV Namespaces
wrangler kv namespace create VERIFICATION_CACHE
wrangler kv namespace create RATE_LIMITS
wrangler kv namespace create SESSIONS

# D1 Database
wrangler d1 create aevion-verification-audit

# R2 Bucket
wrangler r2 bucket create evidence-chain

# Vectorize Index
wrangler vectorize create vetproof-evidence --dimensions 768 --metric cosine

# Queue
wrangler queues create vetproof-queue
```

### 3. Configure
```bash
cp configs/wrangler.example.toml wrangler.toml
# Edit wrangler.toml and replace all YOUR_* placeholders
```

### 4. Set Secrets
```bash
wrangler secret put SIGNING_KEY
wrangler secret put API_SECRET
```

### 5. Initialize D1 Tables
```sql
-- Run via: wrangler d1 execute aevion-verification-audit --command "..."

CREATE TABLE IF NOT EXISTS verification_proofs (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  proof_hash TEXT NOT NULL,
  proof_type TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  claim_id TEXT,
  data TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit_log (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_proofs_claim ON verification_proofs(claim_id);
CREATE INDEX idx_audit_claim ON audit_events(claim_id);
CREATE INDEX idx_rate_key ON rate_limit_log(key);
```

### 6. Deploy
```bash
# Deploy individual workers (each needs its own wrangler config or --name flag)
wrangler deploy --name aevion-edge-sheriff
wrangler deploy --name aevion-ai-sheriff
wrangler deploy --name aevion-proof-agent
wrangler deploy --name aevion-vetproof-hitl
wrangler deploy --name aevion-vetproof-workflow
wrangler deploy --name aevion-vetproof-consensus
wrangler deploy --name aevion-sentient-collective
wrangler deploy --name aevion-regulation-tracker
```

---

## Patent Coverage

These workers implement the following patent claims from US 63/896,282:

| Claim | Description | Worker(s) |
|-------|-------------|-----------|
| 3 | Constitutional Halt (confidence threshold gate) | vetproof-hitl, vetproof-workflow, vetproof-consensus |
| 5 | Weighted multi-model voting | vetproof-consensus, proof-agent |
| 7 | Accuracy improvement via ensemble | vetproof-consensus |
| 10 | Hardware root-of-trust verification | edge-sheriff (Ed25519) |
| 12 | Trust Discrimination Score (TDS) | vetproof-consensus |
| 79-82 | Multi-verifier formal proof system | vetproof-workflow, vetproof-consensus |
| 83-84 | Legal reasoning pipeline (38 CFR) | vetproof-hitl, vetproof-workflow |
| 85+ | Multi-vertical collective intelligence | sentient-collective |
| 85+ | Cross-domain regulatory symbiosis | regulation-tracker |
| 85+ | Quantum Shard Learning (anonymized knowledge sharing) | sentient-collective, regulation-tracker |
| 85+ | Automated compliance artifact generation | compliance-reporter |
| 85+ | Self-service verification demo | demo-sandbox |
| 85+ | Fleet health monitoring and alerting | fleet-health-monitor, notification-hub |
| 85+ | x402 payment metering and revenue tracking | revenue-gateway |

---

## CEO Operations Layer (Workers 10-14)

These workers automate business operations for a solo non-coding CEO. No staff required.

### 10. fleet-health-monitor (`fleet-health-monitor.js`)
**Type**: Scheduled (Cron) Worker + KV + D1

Monitors the entire 14-worker fleet every 15 minutes. One endpoint gives you fleet health, uptime stats, cost estimates, and active alerts.

| Feature | Detail |
|---------|--------|
| Cron schedule | `*/15 * * * *` (every 15 minutes) |
| Fleet topology | All 14 workers + Pi Sheriff |
| Uptime tracking | 24h, 7d, 30d windows |
| Cost estimator | Tracks against free-tier limits |
| Alert system | 3 consecutive failures = P0 alert |

**Endpoints**: `/health`, `/v1/fleet`, `/v1/dashboard`, `/v1/uptime`, `/v1/costs`, `/v1/alerts`

---

### 11. revenue-gateway (`revenue-gateway.js`)
**Type**: Stateless Worker + KV + D1

API key management, usage metering, and billing infrastructure. Four pricing tiers with x402 payment support and Stripe-ready billing events.

| Feature | Detail |
|---------|--------|
| Tiers | Free (100/day), Pro (500/day, $99), Enterprise (50K/day, $499), Government (100K/day, custom) |
| API keys | `av_` prefixed, KV-backed |
| Metering | Daily/monthly counters with overage tracking |
| x402 | HTTP 402 Payment Required with `X-Payment` headers |
| Revenue metrics | MRR, ARR, tier breakdown, growth rate |

**Endpoints**: `/health`, `/v1/pricing`, `/v1/keys/create`, `/v1/keys/validate`, `/v1/usage`, `/v1/revenue`, `/v1/verify`

---

### 12. compliance-reporter (`compliance-reporter.js`)
**Type**: Stateless Worker + D1

Auto-generates compliance artifacts for NIST AI RMF, EU AI Act, CMMC Level 2, and ISO 42001. One endpoint produces all compliance docs needed for proposals and audits.

| Feature | Detail |
|---------|--------|
| Frameworks | NIST AI RMF, EU AI Act, CMMC 2.0, ISO/IEC 42001 |
| Scoring | Per-framework and overall compliance percentage |
| Reports | JSON and Markdown formats |
| Proposal artifacts | Technical volume, past performance, cost volume |
| Gap analysis | Identifies remaining compliance gaps |

**Endpoints**: `/health`, `/v1/frameworks`, `/v1/summary`, `/v1/report/{framework}`, `/v1/report/{framework}/markdown`, `/v1/full-report`, `/v1/artifact/{type}`, `/v1/gaps`

---

### 13. demo-sandbox (`demo-sandbox.js`)
**Type**: Stateless Worker + KV + D1

Self-service prospect demo. Four interactive scenarios let prospects try verification without an account or sales call. Includes lead capture and demo analytics.

| Feature | Detail |
|---------|--------|
| Scenarios | VetProof, Legal, Finance, Constitutional Halt |
| Rate limit | 10 demos/day per IP (anonymous) |
| Lead capture | Optional email for follow-up |
| Analytics | Scenario popularity, conversion rate |
| Simulated pipeline | Realistic 5-step evidence chain with proof hashes |

**Endpoints**: `/health`, `/v1/scenarios`, `/v1/demo/{scenario}`, `/v1/pricing`, `/v1/analytics`

---

### 14. notification-hub (`notification-hub.js`)
**Type**: Scheduled (Cron) Worker + KV + D1

Multi-channel alert system. Discord, email (MailChannels), and generic webhook support with priority-based routing. Never miss a critical event.

| Feature | Detail |
|---------|--------|
| Channels | Discord webhook, email (MailChannels), generic webhook |
| Priority routing | P0: all channels, P1: discord+email, P2-P3: discord |
| Pending alerts | Reads from KV (set by fleet-health-monitor) |
| Daily digest | 8am CT summary of demos, alerts, API calls |
| Cron | `*/5 * * * *` (alert check), `0 14 * * *` (daily digest) |

**Endpoints**: `/health`, `/v1/alert`, `/v1/process-pending`, `/v1/history`, `/v1/test`, `/v1/channels`

---

## Cost Estimate

| Tier | Workers | KV | D1 | R2 | AI | Total |
|------|---------|----|----|----|----|-------|
| Free | 100K req/day | 100K reads | 5M rows | 10GB | 10K neurons | $0/mo |
| Paid | 10M req/mo | Unlimited | 25B rows | 10GB free | 10K free | $5/mo |
| Scale | Unlimited | Unlimited | Unlimited | Pay-per-use | Pay-per-use | ~$25-90/mo |

---

## License

Patent-pending. See US 63/896,282 for protected claims.
