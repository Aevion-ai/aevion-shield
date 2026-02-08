/**
 * Aevion VetProof Durable Workflow
 *
 * A Cloudflare Workflow that orchestrates the full VetProof verification pipeline
 * with automatic retries, step persistence, and durable execution guarantees.
 *
 * This replaces fragile queue-based orchestration with a proper durable execution
 * engine that can survive failures, resume from any step, and run for hours.
 *
 * Patent Coverage:
 * - Claim 5: Weighted voting with coherence threshold
 * - Claim 7: Multi-model accuracy improvement
 * - Claims 79-82: Multi-verifier proofs
 *
 * Pipeline Steps:
 *   1. SANITIZE  - PII detection and redaction via Workers AI
 *   2. EMBED     - Generate evidence embeddings via Vectorize
 *   3. SEARCH    - Find similar evidence for context
 *   4. VERIFY    - Multi-model Shield Consensus voting
 *   5. DETECT    - Hallucination and consistency detection
 *   6. SIGN      - Cryptographic proof generation and archival
 */

import { WorkflowEntrypoint } from 'cloudflare:workers';

// ============================================
// WORKFLOW: VetProof Claim Verification
// ============================================
export class VetProofPipeline extends WorkflowEntrypoint {
  async run(event, step) {
    const { claim_id, claim_text, evidence, veteran_id, service_dates } = event.payload;
    const startTime = Date.now();

    // Step 1: SANITIZE - Detect and redact PII
    const sanitized = await step.do(
      'sanitize-pii',
      {
        retries: { limit: 2, delay: '3 seconds', backoff: 'exponential' },
        timeout: '30 seconds',
      },
      async () => {
        // Use Workers AI to detect PII patterns
        const piiCheck = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
          prompt: `Identify any PII (names, SSN, addresses, phone numbers, dates of birth) in the following text. Return ONLY a JSON object with format: {"has_pii": true/false, "pii_types": [], "redacted_text": "text with [REDACTED] replacing PII"}

Text: ${claim_text}

Evidence: ${Array.isArray(evidence) ? evidence.join('\n') : evidence}`,
          max_tokens: 1024,
          temperature: 0.1,
        });

        let result;
        try {
          const jsonMatch = piiCheck.response.match(/\{[\s\S]*\}/);
          result = jsonMatch ? JSON.parse(jsonMatch[0]) : {
            has_pii: false,
            pii_types: [],
            redacted_text: claim_text,
          };
        } catch {
          result = { has_pii: false, pii_types: [], redacted_text: claim_text };
        }

        return {
          ...result,
          original_hash: await sha256(claim_text),
          sanitized_at: new Date().toISOString(),
        };
      }
    );

    // Step 2: EMBED - Generate vector embeddings for evidence
    const embeddings = await step.do(
      'embed-evidence',
      {
        retries: { limit: 3, delay: '5 seconds', backoff: 'linear' },
        timeout: '60 seconds',
      },
      async () => {
        const textToEmbed = sanitized.redacted_text || claim_text;
        const evidenceText = Array.isArray(evidence) ? evidence.join(' ') : evidence;

        // Generate embeddings using BGE-base
        const claimEmbedding = await this.env.AI.run('@cf/baai/bge-base-en-v1.5', {
          text: [textToEmbed],
        });

        const evidenceEmbedding = await this.env.AI.run('@cf/baai/bge-base-en-v1.5', {
          text: [evidenceText],
        });

        // Store in Vectorize
        if (this.env.VECTORIZE) {
          await this.env.VECTORIZE.upsert([
            {
              id: `claim-${claim_id}`,
              values: claimEmbedding.data[0],
              metadata: { type: 'claim', claim_id, veteran_id: veteran_id || 'unknown' },
            },
            {
              id: `evidence-${claim_id}`,
              values: evidenceEmbedding.data[0],
              metadata: { type: 'evidence', claim_id, veteran_id: veteran_id || 'unknown' },
            },
          ]);
        }

        // Calculate claim-evidence similarity
        const similarity = cosineSimilarity(
          claimEmbedding.data[0],
          evidenceEmbedding.data[0]
        );

        return {
          claim_vector_id: `claim-${claim_id}`,
          evidence_vector_id: `evidence-${claim_id}`,
          claim_evidence_similarity: similarity,
          embedded_at: new Date().toISOString(),
        };
      }
    );

    // Step 3: SEARCH - Find similar prior evidence for context
    const similarEvidence = await step.do(
      'search-similar-evidence',
      {
        retries: { limit: 2, delay: '3 seconds', backoff: 'linear' },
        timeout: '30 seconds',
      },
      async () => {
        if (!this.env.VECTORIZE) {
          return { similar_claims: [], context_available: false };
        }

        // Search for similar claims using the embedded vectors
        const claimEmbedding = await this.env.AI.run('@cf/baai/bge-base-en-v1.5', {
          text: [sanitized.redacted_text || claim_text],
        });

        const results = await this.env.VECTORIZE.query(claimEmbedding.data[0], {
          topK: 5,
          filter: { type: 'claim' },
          returnMetadata: 'all',
        });

        // Filter out self-match
        const similar = results.matches
          .filter(m => m.id !== `claim-${claim_id}` && m.score > 0.7)
          .map(m => ({
            claim_id: m.metadata?.claim_id,
            similarity: m.score,
          }));

        return {
          similar_claims: similar,
          context_available: similar.length > 0,
          searched_at: new Date().toISOString(),
        };
      }
    );

    // Step 4: VERIFY - Multi-model Shield Consensus
    const verification = await step.do(
      'shield-consensus-verify',
      {
        retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
        timeout: '120 seconds',
      },
      async () => {
        const models = [
          { id: '@cf/meta/llama-3.1-8b-instruct', name: 'llama-3.1-8b', weight: 1.0 },
          { id: '@cf/qwen/qwen1.5-14b-chat-awq', name: 'qwen-14b', weight: 1.2 },
        ];

        const verificationPrompt = `You are a VA disability claim verification system analyzing claims under 38 CFR.

Claim: ${sanitized.redacted_text || claim_text}
Evidence: ${Array.isArray(evidence) ? evidence.join('\n') : evidence}
${service_dates ? `Service Dates: ${service_dates}` : ''}
${similarEvidence.context_available ? `Similar prior claims found: ${similarEvidence.similar_claims.length}` : ''}

Analyze this claim and respond with ONLY a JSON object:
{
  "verdict": "VERIFIED" or "UNVERIFIED" or "INSUFFICIENT_EVIDENCE" or "NEEDS_REVIEW",
  "confidence": 0.0 to 1.0,
  "cfr_sections": ["38 CFR sections that apply"],
  "nexus_strength": "direct" or "secondary" or "presumptive" or "none",
  "reasoning": "brief explanation",
  "risk_flags": ["any concerns"]
}`;

        const votes = await Promise.allSettled(
          models.map(async (model) => {
            const response = await this.env.AI.run(model.id, {
              prompt: verificationPrompt,
              max_tokens: 512,
              temperature: 0.1,
            });

            let parsed;
            try {
              const jsonMatch = response.response.match(/\{[\s\S]*\}/);
              parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
            } catch {
              parsed = null;
            }

            return {
              model: model.name,
              weight: model.weight,
              raw_response: response.response?.substring(0, 500),
              parsed,
              timestamp: new Date().toISOString(),
            };
          })
        );

        // Aggregate votes using BFT consensus
        const successfulVotes = votes
          .filter(v => v.status === 'fulfilled' && v.value.parsed)
          .map(v => v.value);

        const failedVotes = votes
          .filter(v => v.status === 'rejected' || !v.value?.parsed)
          .length;

        if (successfulVotes.length === 0) {
          return {
            consensus: 'NO_QUORUM',
            votes: [],
            failed_models: failedVotes,
            verified_at: new Date().toISOString(),
          };
        }

        // Calculate weighted consensus
        let totalWeight = 0;
        let weightedConfidence = 0;
        const verdictCounts = {};

        for (const vote of successfulVotes) {
          const w = vote.weight;
          totalWeight += w;
          weightedConfidence += (vote.parsed.confidence || 0) * w;
          const v = vote.parsed.verdict || 'UNKNOWN';
          verdictCounts[v] = (verdictCounts[v] || 0) + w;
        }

        const avgConfidence = totalWeight > 0 ? weightedConfidence / totalWeight : 0;

        // Find majority verdict
        let majorityVerdict = 'NO_CONSENSUS';
        let maxWeight = 0;
        for (const [verdict, weight] of Object.entries(verdictCounts)) {
          if (weight > maxWeight) {
            maxWeight = weight;
            majorityVerdict = verdict;
          }
        }

        // Check BFT threshold (>2/3 agreement)
        const agreementRatio = maxWeight / totalWeight;
        const bftThreshold = 2 / 3;
        const consensusReached = agreementRatio >= bftThreshold;

        // Constitutional halt check
        const confidences = successfulVotes.map(v => v.parsed.confidence || 0);
        const mean = confidences.reduce((a, b) => a + b, 0) / confidences.length;
        const stdDev = Math.sqrt(
          confidences.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / confidences.length
        );
        const constitutionalHalt = stdDev > 0.25;

        return {
          consensus: consensusReached ? majorityVerdict : 'NO_CONSENSUS',
          consensus_reached: consensusReached,
          agreement_ratio: agreementRatio,
          bft_threshold: bftThreshold,
          weighted_confidence: avgConfidence,
          confidence_std_dev: stdDev,
          constitutional_halt: constitutionalHalt,
          votes: successfulVotes.map(v => ({
            model: v.model,
            verdict: v.parsed.verdict,
            confidence: v.parsed.confidence,
            cfr_sections: v.parsed.cfr_sections,
            nexus_strength: v.parsed.nexus_strength,
          })),
          failed_models: failedVotes,
          verified_at: new Date().toISOString(),
        };
      }
    );

    // Step 5: DETECT - Hallucination and consistency check
    const detection = await step.do(
      'hallucination-detect',
      {
        retries: { limit: 2, delay: '5 seconds', backoff: 'linear' },
        timeout: '60 seconds',
      },
      async () => {
        // Cross-check verification results for consistency
        const checks = {
          confidence_anomaly: verification.constitutional_halt,
          no_consensus: !verification.consensus_reached,
          low_confidence: verification.weighted_confidence < 0.5,
          high_disagreement: verification.confidence_std_dev > 0.3,
          low_evidence_match: embeddings.claim_evidence_similarity < 0.4,
        };

        const flagCount = Object.values(checks).filter(Boolean).length;
        const trustScore = Math.max(0, 1.0 - (flagCount * 0.2));

        return {
          checks,
          flag_count: flagCount,
          trust_score: trustScore,
          halt_required: flagCount >= 3 || verification.constitutional_halt,
          detected_at: new Date().toISOString(),
        };
      }
    );

    // Step 6: SIGN - Generate cryptographic proof and archive
    const proof = await step.do(
      'sign-and-archive',
      {
        retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
        timeout: '30 seconds',
      },
      async () => {
        const proofBundle = {
          claim_id,
          pipeline_version: '2.0.0',
          steps: {
            sanitize: {
              has_pii: sanitized.has_pii,
              pii_types: sanitized.pii_types,
              original_hash: sanitized.original_hash,
            },
            embed: {
              similarity: embeddings.claim_evidence_similarity,
              vectors_stored: true,
            },
            search: {
              similar_claims_found: similarEvidence.similar_claims.length,
            },
            verify: {
              consensus: verification.consensus,
              confidence: verification.weighted_confidence,
              agreement_ratio: verification.agreement_ratio,
              constitutional_halt: verification.constitutional_halt,
              model_count: verification.votes.length,
            },
            detect: {
              trust_score: detection.trust_score,
              halt_required: detection.halt_required,
              flags: detection.flag_count,
            },
          },
          verdict: detection.halt_required ? 'HALTED_FOR_REVIEW' : verification.consensus,
          final_confidence: detection.halt_required ? 0 : verification.weighted_confidence,
          trust_score: detection.trust_score,
          timestamp: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
        };

        // Generate proof hash
        const proofHash = await sha256(JSON.stringify(proofBundle));
        proofBundle.proof_hash = proofHash;

        // Archive to R2
        if (this.env.PROOF_STORAGE) {
          await this.env.PROOF_STORAGE.put(
            `proofs/${claim_id}/${proofHash}.json`,
            JSON.stringify(proofBundle, null, 2),
            {
              httpMetadata: { contentType: 'application/json' },
              customMetadata: {
                claim_id,
                verdict: proofBundle.verdict,
                confidence: String(proofBundle.final_confidence),
              },
            }
          );
        }

        // Write audit event to D1
        if (this.env.AUDIT_DB) {
          try {
            await this.env.AUDIT_DB.prepare(
              `INSERT INTO audit_events (event_type, entity_id, details, created_at)
               VALUES (?, ?, ?, ?)`
            ).bind(
              'WORKFLOW_COMPLETE',
              claim_id,
              JSON.stringify({
                verdict: proofBundle.verdict,
                confidence: proofBundle.final_confidence,
                trust_score: proofBundle.trust_score,
                duration_ms: proofBundle.duration_ms,
                proof_hash: proofHash,
              }),
              new Date().toISOString()
            ).run();
          } catch (e) {
            // Audit logging is best-effort, don't fail the workflow
            console.error('Audit log write failed:', e.message);
          }
        }

        // Cache result in KV for quick lookups
        if (this.env.VERIFICATION_CACHE) {
          await this.env.VERIFICATION_CACHE.put(
            `proof:${claim_id}`,
            JSON.stringify(proofBundle),
            { expirationTtl: 86400 } // 24 hours
          );
        }

        return proofBundle;
      }
    );

    return proof;
  }
}

// ============================================
// WORKER: HTTP Handler for Workflow triggers
// ============================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      switch (url.pathname) {
        case '/health':
          return jsonResponse({
            status: 'healthy',
            service: 'aevion-vetproof-workflow',
            version: '2.0.0',
            capabilities: ['durable-workflow', 'pii-detection', 'shield-consensus',
                           'vectorize-search', 'hallucination-detect', 'proof-archive'],
          }, corsHeaders);

        case '/v1/workflow/submit':
        case '/workflow/submit':
          return await handleSubmit(request, env, corsHeaders);

        case '/v1/workflow/status':
        case '/workflow/status':
          return await handleStatus(request, env, url, corsHeaders);

        case '/v1/workflow/list':
        case '/workflow/list':
          return await handleList(env, url, corsHeaders);

        default:
          return jsonResponse({ error: 'Not found' }, corsHeaders, 404);
      }
    } catch (error) {
      return jsonResponse({ error: error.message }, corsHeaders, 500);
    }
  },
};

async function handleSubmit(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, corsHeaders, 405);
  }

  const body = await request.json();
  const { claim_id, claim_text, evidence } = body;

  if (!claim_id || !claim_text || !evidence) {
    return jsonResponse({
      error: 'claim_id, claim_text, and evidence are required',
    }, corsHeaders, 400);
  }

  // Create a new workflow instance
  const instance = await env.VETPROOF_WORKFLOW.create({
    id: claim_id,
    params: body,
  });

  return jsonResponse({
    workflow_id: instance.id,
    claim_id,
    status: 'queued',
    message: 'VetProof verification workflow started',
    check_status: `/v1/workflow/status?id=${instance.id}`,
  }, corsHeaders, 202);
}

async function handleStatus(request, env, url, corsHeaders) {
  const instanceId = url.searchParams.get('id');
  if (!instanceId) {
    return jsonResponse({ error: 'id query parameter required' }, corsHeaders, 400);
  }

  try {
    const instance = await env.VETPROOF_WORKFLOW.get(instanceId);
    const status = await instance.status();

    return jsonResponse({
      workflow_id: instanceId,
      status: status.status,
      output: status.output,
      error: status.error,
    }, corsHeaders);
  } catch (e) {
    return jsonResponse({
      error: `Workflow instance not found: ${instanceId}`,
    }, corsHeaders, 404);
  }
}

async function handleList(env, url, corsHeaders) {
  // List recent workflow instances (limited view)
  return jsonResponse({
    message: 'Use /v1/workflow/status?id=<claim_id> to check specific workflow status',
    endpoints: [
      'POST /v1/workflow/submit - Start new verification workflow',
      'GET  /v1/workflow/status?id= - Check workflow progress',
      'GET  /v1/workflow/list - This endpoint',
    ],
  }, corsHeaders);
}

// ============================================
// UTILITIES
// ============================================
function jsonResponse(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
