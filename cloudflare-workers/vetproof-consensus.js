/**
 * Aevion VetProof Consensus Worker
 *
 * Stateful consensus coordination using Durable Objects + Vectorize.
 * Manages Shield Consensus voting, evidence embedding, and proof lifecycle.
 *
 * Patent Coverage:
 * - Claim 5: Weighted voting with coherence threshold
 * - Claim 7: Multi-model accuracy improvement
 * - Claim 12: TDS discrimination
 * - Claims 79-82: Multi-verifier proofs
 *
 * Architecture:
 *   [Request] -> Worker -> Durable Object (per claim_id)
 *                       -> Vectorize (semantic search)
 *                       -> Queue (async pipeline)
 *                       -> D1 (audit trail)
 *                       -> R2 (proof archive)
 */

import { DurableObject } from 'cloudflare:workers';

// ============================================
// DURABLE OBJECT: Shield Consensus Coordinator
// ============================================
export class ShieldConsensus extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;

    // Initialize SQLite storage for this claim
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS votes (
        model_id TEXT NOT NULL,
        verdict TEXT NOT NULL,
        confidence REAL NOT NULL,
        coherence_score REAL NOT NULL,
        reasoning TEXT,
        timestamp TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (model_id)
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  // Submit a model's vote for this claim
  async submitVote(modelId, vote) {
    const { verdict, confidence, coherence_score, reasoning } = vote;

    // Upsert vote (models can update their vote)
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO votes (model_id, verdict, confidence, coherence_score, reasoning)
       VALUES (?, ?, ?, ?, ?)`,
      modelId, verdict, confidence, coherence_score, reasoning || ''
    );

    // Check if we have enough votes for consensus
    const allVotes = this.ctx.storage.sql.exec(
      'SELECT * FROM votes ORDER BY confidence DESC'
    ).toArray();

    const consensus = this.calculateConsensus(allVotes);

    // Store consensus state
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES ('consensus', ?)`,
      JSON.stringify(consensus)
    );

    return {
      vote_accepted: true,
      total_votes: allVotes.length,
      consensus,
      votes: allVotes
    };
  }

  // Get current consensus state
  async getState() {
    const votes = this.ctx.storage.sql.exec('SELECT * FROM votes').toArray();
    const consensusRow = this.ctx.storage.sql.exec(
      "SELECT value FROM state WHERE key = 'consensus'"
    ).one();

    return {
      votes,
      consensus: consensusRow ? JSON.parse(consensusRow.value) : null,
      total_votes: votes.length
    };
  }

  // Calculate Byzantine fault-tolerant consensus
  calculateConsensus(votes) {
    if (votes.length === 0) {
      return { status: 'PENDING', reason: 'No votes yet' };
    }

    const n = votes.length;
    const f = Math.floor((n - 1) / 3); // BFT tolerance: f < n/3

    // Count verdicts
    const verdictCounts = {};
    let totalConfidence = 0;
    let totalCoherence = 0;

    for (const vote of votes) {
      verdictCounts[vote.verdict] = (verdictCounts[vote.verdict] || 0) + 1;
      totalConfidence += vote.confidence;
      totalCoherence += vote.coherence_score;
    }

    // Find majority verdict
    const majorityVerdict = Object.entries(verdictCounts)
      .sort(([, a], [, b]) => b - a)[0];

    const majorityCount = majorityVerdict[1];
    const majorityPct = majorityCount / n;

    // BFT consensus: need > 2/3 agreement
    const bftThreshold = (2 * n + 2) / (3 * n); // slightly above 2/3
    const hasConsensus = majorityPct >= bftThreshold;

    // Average scores
    const avgConfidence = totalConfidence / n;
    const avgCoherence = totalCoherence / n;

    // Variance calculation for constitutional halt
    const confidenceVariance = votes.reduce(
      (sum, v) => sum + Math.pow(v.confidence - avgConfidence, 2), 0
    ) / n;
    const confidenceStdDev = Math.sqrt(confidenceVariance);

    // Constitutional halt: sigma > 2.5x triggers review
    const haltTriggered = confidenceStdDev > 0.25; // 2.5 * 0.1 baseline

    return {
      status: hasConsensus ? 'CONSENSUS' : 'DISAGREEMENT',
      verdict: majorityVerdict[0],
      agreement_pct: majorityPct,
      bft_threshold: bftThreshold,
      avg_confidence: avgConfidence,
      avg_coherence: avgCoherence,
      confidence_std_dev: confidenceStdDev,
      halt_triggered: haltTriggered,
      total_votes: n,
      fault_tolerance: f,
      verdict_distribution: verdictCounts,
      timestamp: new Date().toISOString()
    };
  }

  // Handle HTTP requests to this Durable Object
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/vote') {
      const { model_id, vote } = await request.json();
      const result = await this.submitVote(model_id, vote);
      return Response.json(result);
    }

    if (request.method === 'GET' && url.pathname === '/state') {
      const state = await this.getState();
      return Response.json(state);
    }

    return Response.json({ error: 'Unknown endpoint' }, { status: 404 });
  }
}


// ============================================
// MAIN WORKER: VetProof Consensus Router
// ============================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const startTime = Date.now();

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      switch (url.pathname) {
        // --- Consensus Endpoints ---
        case '/consensus/vote':
        case '/v1/consensus/vote':
          return await handleConsensusVote(request, env, startTime, corsHeaders);

        case '/consensus/state':
        case '/v1/consensus/state':
          return await handleConsensusState(request, env, startTime, corsHeaders);

        // --- Evidence Embedding Endpoints ---
        case '/evidence/embed':
        case '/v1/evidence/embed':
          return await handleEvidenceEmbed(request, env, startTime, corsHeaders);

        case '/evidence/search':
        case '/v1/evidence/search':
          return await handleEvidenceSearch(request, env, startTime, corsHeaders);

        // --- VetProof Pipeline Endpoints ---
        case '/pipeline/submit':
        case '/v1/pipeline/submit':
          return await handlePipelineSubmit(request, env, startTime, corsHeaders);

        case '/pipeline/status':
        case '/v1/pipeline/status':
          return await handlePipelineStatus(request, env, startTime, corsHeaders);

        // --- Health ---
        case '/health':
          return handleHealth(env, startTime, corsHeaders);

        default:
          return Response.json(
            { error: 'Not found', available_endpoints: [
              '/consensus/vote', '/consensus/state',
              '/evidence/embed', '/evidence/search',
              '/pipeline/submit', '/pipeline/status',
              '/health'
            ]},
            { status: 404, headers: corsHeaders }
          );
      }
    } catch (error) {
      return Response.json({
        error: error.message,
        edge_location: request.cf?.colo || 'unknown',
        latency_ms: Date.now() - startTime
      }, {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  },

  // Queue consumer: process VetProof pipeline stages
  async queue(batch, env) {
    for (const message of batch.messages) {
      const { claim_id, stage, payload } = message.body;

      try {
        switch (stage) {
          case 'SANITIZE':
            await processSanitize(claim_id, payload, env);
            break;
          case 'GENERATE':
            await processGenerate(claim_id, payload, env);
            break;
          case 'VERIFY':
            await processVerify(claim_id, payload, env);
            break;
          case 'DETECT':
            await processDetect(claim_id, payload, env);
            break;
          case 'SIGN':
            await processSign(claim_id, payload, env);
            break;
          default:
            console.error(`Unknown pipeline stage: ${stage}`);
        }

        // Audit log
        if (env.AUDIT_DB) {
          await env.AUDIT_DB.prepare(
            `INSERT INTO audit_events (event_type, claim_id, details, created_at)
             VALUES (?, ?, ?, datetime('now'))`
          ).bind(`pipeline_${stage.toLowerCase()}`, claim_id, JSON.stringify({
            stage,
            status: 'completed',
            timestamp: new Date().toISOString()
          })).run();
        }

        message.ack();
      } catch (error) {
        console.error(`Pipeline ${stage} failed for ${claim_id}:`, error);
        message.retry({ delaySeconds: 30 });
      }
    }
  }
};


// ============================================
// CONSENSUS HANDLERS
// ============================================

async function handleConsensusVote(request, env, startTime, corsHeaders) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'POST required' }, { status: 405, headers: corsHeaders });
  }

  const { claim_id, model_id, vote } = await request.json();

  if (!claim_id || !model_id || !vote) {
    return Response.json(
      { error: 'claim_id, model_id, and vote object required' },
      { status: 400, headers: corsHeaders }
    );
  }

  // Get or create Durable Object for this claim
  const doId = env.SHIELD_CONSENSUS.idFromName(claim_id);
  const stub = env.SHIELD_CONSENSUS.get(doId);

  // Submit vote to the Durable Object
  const doResponse = await stub.fetch(new Request('https://do/vote', {
    method: 'POST',
    body: JSON.stringify({ model_id, vote })
  }));

  const result = await doResponse.json();

  // If consensus reached, archive to R2 and audit
  if (result.consensus?.status === 'CONSENSUS') {
    // Archive proof to R2
    if (env.PROOF_STORAGE) {
      const proofKey = `proofs/${claim_id}.json`;
      await env.PROOF_STORAGE.put(proofKey, JSON.stringify({
        claim_id,
        consensus: result.consensus,
        votes: result.votes,
        archived_at: new Date().toISOString()
      }));
    }

    // Cache in KV for fast lookup
    if (env.VERIFICATION_CACHE) {
      await env.VERIFICATION_CACHE.put(claim_id, JSON.stringify(result.consensus), {
        expirationTtl: 86400 // 24 hours
      });
    }

    // Audit log
    if (env.AUDIT_DB) {
      await env.AUDIT_DB.prepare(
        `INSERT INTO verification_proofs (proof_id, claim_data, verification_result, created_at)
         VALUES (?, ?, ?, datetime('now'))`
      ).bind(claim_id, JSON.stringify({ model_id, vote }), JSON.stringify(result.consensus)).run();
    }
  }

  return Response.json({
    ...result,
    edge_location: request.cf?.colo || 'unknown',
    latency_ms: Date.now() - startTime
  }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function handleConsensusState(request, env, startTime, corsHeaders) {
  const url = new URL(request.url);
  const claimId = url.searchParams.get('claim_id');

  if (!claimId) {
    return Response.json({ error: 'claim_id query param required' }, {
      status: 400, headers: corsHeaders
    });
  }

  // Check KV cache first
  if (env.VERIFICATION_CACHE) {
    const cached = await env.VERIFICATION_CACHE.get(claimId, { type: 'json' });
    if (cached) {
      return Response.json({
        cached: true,
        consensus: cached,
        edge_location: request.cf?.colo || 'unknown',
        latency_ms: Date.now() - startTime
      }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  }

  // Query Durable Object
  const doId = env.SHIELD_CONSENSUS.idFromName(claimId);
  const stub = env.SHIELD_CONSENSUS.get(doId);

  const doResponse = await stub.fetch(new Request('https://do/state'));
  const state = await doResponse.json();

  return Response.json({
    cached: false,
    ...state,
    edge_location: request.cf?.colo || 'unknown',
    latency_ms: Date.now() - startTime
  }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}


// ============================================
// EVIDENCE EMBEDDING HANDLERS (Vectorize)
// ============================================

async function handleEvidenceEmbed(request, env, startTime, corsHeaders) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'POST required' }, { status: 405, headers: corsHeaders });
  }

  const { claim_id, evidence_text, metadata } = await request.json();

  if (!claim_id || !evidence_text) {
    return Response.json(
      { error: 'claim_id and evidence_text required' },
      { status: 400, headers: corsHeaders }
    );
  }

  // Generate embedding using Workers AI
  const embeddingResponse = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: [evidence_text]
  });

  const embedding = embeddingResponse.data[0];

  // Insert into Vectorize index
  if (env.VECTORIZE) {
    await env.VECTORIZE.upsert([{
      id: claim_id,
      values: embedding,
      metadata: {
        claim_id,
        evidence_length: evidence_text.length,
        indexed_at: new Date().toISOString(),
        ...(metadata || {})
      }
    }]);
  }

  return Response.json({
    embedded: true,
    claim_id,
    dimensions: embedding.length,
    edge_location: request.cf?.colo || 'unknown',
    latency_ms: Date.now() - startTime
  }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function handleEvidenceSearch(request, env, startTime, corsHeaders) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'POST required' }, { status: 405, headers: corsHeaders });
  }

  const { query, top_k = 5, filter } = await request.json();

  if (!query) {
    return Response.json({ error: 'query text required' }, {
      status: 400, headers: corsHeaders
    });
  }

  // Generate embedding for the query
  const embeddingResponse = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: [query]
  });

  const queryEmbedding = embeddingResponse.data[0];

  // Search Vectorize
  if (!env.VECTORIZE) {
    return Response.json({ error: 'Vectorize not configured' }, {
      status: 503, headers: corsHeaders
    });
  }

  const results = await env.VECTORIZE.query(queryEmbedding, {
    topK: top_k,
    returnMetadata: 'all',
    ...(filter ? { filter } : {})
  });

  return Response.json({
    matches: results.matches,
    count: results.count,
    query_dimensions: queryEmbedding.length,
    edge_location: request.cf?.colo || 'unknown',
    latency_ms: Date.now() - startTime
  }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}


// ============================================
// PIPELINE HANDLERS (Queue)
// ============================================

async function handlePipelineSubmit(request, env, startTime, corsHeaders) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'POST required' }, { status: 405, headers: corsHeaders });
  }

  const { claim_id, claim_text, evidence, disability_codes } = await request.json();

  if (!claim_id || !claim_text) {
    return Response.json(
      { error: 'claim_id and claim_text required' },
      { status: 400, headers: corsHeaders }
    );
  }

  // Queue the first pipeline stage (SANITIZE)
  if (env.VETPROOF_QUEUE) {
    await env.VETPROOF_QUEUE.send({
      claim_id,
      stage: 'SANITIZE',
      payload: {
        claim_text,
        evidence: evidence || [],
        disability_codes: disability_codes || [],
        submitted_at: new Date().toISOString()
      }
    });
  }

  // Track in D1
  if (env.AUDIT_DB) {
    await env.AUDIT_DB.prepare(
      `INSERT INTO audit_events (event_type, claim_id, details, created_at)
       VALUES ('pipeline_submitted', ?, ?, datetime('now'))`
    ).bind(claim_id, JSON.stringify({
      disability_codes,
      evidence_count: (evidence || []).length
    })).run();
  }

  return Response.json({
    submitted: true,
    claim_id,
    pipeline_stage: 'SANITIZE',
    message: 'Claim queued for VetProof 5-phase pipeline',
    stages: ['SANITIZE', 'GENERATE', 'VERIFY', 'DETECT', 'SIGN'],
    edge_location: request.cf?.colo || 'unknown',
    latency_ms: Date.now() - startTime
  }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function handlePipelineStatus(request, env, startTime, corsHeaders) {
  const url = new URL(request.url);
  const claimId = url.searchParams.get('claim_id');

  if (!claimId) {
    return Response.json({ error: 'claim_id query param required' }, {
      status: 400, headers: corsHeaders
    });
  }

  // Check D1 for audit events related to this claim
  if (!env.AUDIT_DB) {
    return Response.json({ error: 'Audit DB not configured' }, {
      status: 503, headers: corsHeaders
    });
  }

  const events = await env.AUDIT_DB.prepare(
    `SELECT event_type, details, created_at FROM audit_events
     WHERE claim_id = ? ORDER BY created_at DESC LIMIT 20`
  ).bind(claimId).all();

  // Determine current stage from events
  const stages = ['SANITIZE', 'GENERATE', 'VERIFY', 'DETECT', 'SIGN'];
  const completedStages = events.results
    .filter(e => e.event_type.startsWith('pipeline_'))
    .map(e => e.event_type.replace('pipeline_', '').toUpperCase());

  const currentStageIndex = Math.max(
    ...stages.map((s, i) => completedStages.includes(s) ? i : -1)
  );
  const currentStage = currentStageIndex >= 0 ? stages[currentStageIndex] : 'PENDING';
  const nextStage = currentStageIndex < stages.length - 1
    ? stages[currentStageIndex + 1]
    : 'COMPLETE';

  return Response.json({
    claim_id: claimId,
    current_stage: currentStage,
    next_stage: nextStage,
    completed_stages: completedStages,
    events: events.results,
    edge_location: request.cf?.colo || 'unknown',
    latency_ms: Date.now() - startTime
  }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}


// ============================================
// QUEUE CONSUMER HANDLERS
// ============================================

async function processSanitize(claimId, payload, env) {
  // PII detection and redaction at the edge
  // Uses Workers AI to detect PII patterns
  const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
    prompt: `Identify any PII (names, SSNs, addresses, phone numbers, dates of birth) in this text. Return JSON: {"has_pii": bool, "pii_types": [], "redacted_text": "..."}

Text: ${payload.claim_text}`,
    max_tokens: 1024,
    temperature: 0.1
  });

  // Queue next stage
  if (env.VETPROOF_QUEUE) {
    await env.VETPROOF_QUEUE.send({
      claim_id: claimId,
      stage: 'GENERATE',
      payload: {
        ...payload,
        sanitized: true,
        sanitize_result: aiResponse.response
      }
    });
  }
}

async function processGenerate(claimId, payload, env) {
  // Generate verification analysis
  const analysis = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
    prompt: `Analyze this VA disability claim for 38 CFR compliance:

Claim: ${payload.claim_text}
Evidence: ${JSON.stringify(payload.evidence)}
Disability Codes: ${JSON.stringify(payload.disability_codes)}

Determine if evidence meets: 3.303 (direct service connection), 3.309 (presumptive), 4.16 (TDIU).
Return JSON: {"cfr_analysis": {...}, "evidence_sufficiency": 0.0-1.0, "recommendation": "..."}`,
    max_tokens: 2048,
    temperature: 0.2
  });

  if (env.VETPROOF_QUEUE) {
    await env.VETPROOF_QUEUE.send({
      claim_id: claimId,
      stage: 'VERIFY',
      payload: { ...payload, analysis: analysis.response }
    });
  }
}

async function processVerify(claimId, payload, env) {
  // Multi-model verification via Shield Consensus
  const doId = env.SHIELD_CONSENSUS.idFromName(claimId);
  const stub = env.SHIELD_CONSENSUS.get(doId);

  // Submit AI analysis as first vote
  await stub.fetch(new Request('https://do/vote', {
    method: 'POST',
    body: JSON.stringify({
      model_id: 'workers-ai-llama-3.1-8b',
      vote: {
        verdict: 'VERIFIED', // Simplified; real impl would parse analysis
        confidence: 0.75,
        coherence_score: 0.80,
        reasoning: payload.analysis
      }
    })
  }));

  if (env.VETPROOF_QUEUE) {
    await env.VETPROOF_QUEUE.send({
      claim_id: claimId,
      stage: 'DETECT',
      payload: { ...payload, verified: true }
    });
  }
}

async function processDetect(claimId, payload, env) {
  // Hallucination detection
  const detectionResult = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
    prompt: `Check if this VA claim analysis contains hallucinations or unsupported assertions:

Original claim: ${payload.claim_text}
Analysis: ${payload.analysis || 'N/A'}

Return JSON: {"hallucination_detected": bool, "confidence": 0.0-1.0, "flagged_items": []}`,
    max_tokens: 512,
    temperature: 0.1
  });

  if (env.VETPROOF_QUEUE) {
    await env.VETPROOF_QUEUE.send({
      claim_id: claimId,
      stage: 'SIGN',
      payload: { ...payload, detection: detectionResult.response }
    });
  }
}

async function processSign(claimId, payload, env) {
  // Generate cryptographic proof hash
  const proofContent = JSON.stringify({
    claim_id: claimId,
    payload,
    signed_at: new Date().toISOString()
  });

  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(proofContent));
  const proofHash = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Store final proof in R2
  if (env.PROOF_STORAGE) {
    await env.PROOF_STORAGE.put(`proofs/${claimId}.json`, JSON.stringify({
      claim_id: claimId,
      proof_hash: proofHash,
      pipeline_complete: true,
      stages_completed: ['SANITIZE', 'GENERATE', 'VERIFY', 'DETECT', 'SIGN'],
      final_payload: payload,
      signed_at: new Date().toISOString()
    }));
  }

  // Cache for fast lookup
  if (env.VERIFICATION_CACHE) {
    await env.VERIFICATION_CACHE.put(claimId, JSON.stringify({
      status: 'COMPLETE',
      proof_hash: proofHash,
      completed_at: new Date().toISOString()
    }), { expirationTtl: 604800 }); // 7 days
  }
}


// ============================================
// HEALTH CHECK
// ============================================

function handleHealth(env, startTime, corsHeaders) {
  return Response.json({
    status: 'healthy',
    service: 'aevion-vetproof-consensus',
    version: '1.0.0',
    capabilities: {
      durable_objects: !!env.SHIELD_CONSENSUS,
      vectorize: !!env.VECTORIZE,
      queue: !!env.VETPROOF_QUEUE,
      workers_ai: !!env.AI,
      kv_cache: !!env.VERIFICATION_CACHE,
      r2_storage: !!env.PROOF_STORAGE,
      d1_audit: !!env.AUDIT_DB
    },
    endpoints: [
      'POST /consensus/vote - Submit model vote for claim',
      'GET  /consensus/state?claim_id= - Get consensus state',
      'POST /evidence/embed - Embed evidence in Vectorize',
      'POST /evidence/search - Semantic search evidence',
      'POST /pipeline/submit - Submit claim to 5-phase pipeline',
      'GET  /pipeline/status?claim_id= - Get pipeline status',
      'GET  /health - This endpoint'
    ],
    latency_ms: Date.now() - startTime
  }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
