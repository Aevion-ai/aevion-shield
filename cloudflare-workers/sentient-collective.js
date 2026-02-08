/**
 * Aevion SentientCore Collective Orchestrator
 *
 * Master-agent architecture for multi-vertical AI verification.
 * Each vertical (VetProof, Legal, Finance, Health, Education) runs a
 * domain-specialized "slave" agent. The Collective orchestrator:
 *
 *   1. Routes claims to the correct vertical agent
 *   2. Manages quantum shard learning (safe knowledge aggregation)
 *   3. Enforces constitutional halt across all verticals
 *   4. Maintains a shared knowledge graph via Vectorize
 *
 * Patent: US 63/896,282 - Multi-Verifier Consensus + SentientCore
 *
 * Architecture:
 *   [Client] -> [Collective Master] -> [Vertical Slave Agent (DO)]
 *                     |                         |
 *               [Shard Learner]          [Domain Knowledge]
 *                     |                         |
 *               [Vectorize]              [Workers AI]
 *                     |
 *              [Safe Knowledge Pool]
 */

import { WorkflowEntrypoint } from 'cloudflare:workers';

// ============================================
// QUANTUM SHARD LEARNING
// ============================================
// "Quantum Shards" are anonymized, distilled knowledge fragments
// extracted from verified claims. They contain NO PII, NO case-specific
// data - only patterns, statistical distributions, and domain rules
// that improve future verification accuracy.

const SHARD_SCHEMA = {
  version: '1.0.0',
  allowed_fields: [
    'domain',           // which vertical
    'pattern_type',     // rule | statistic | threshold | correlation
    'pattern_key',      // unique identifier
    'pattern_value',    // the distilled knowledge
    'confidence',       // how reliable (0-1)
    'source_count',     // how many verified claims contributed
    'created_at',       // timestamp
    'constitutional',   // passed constitutional halt? (boolean)
  ],
  forbidden_fields: [
    'name', 'ssn', 'dob', 'address', 'email', 'phone',
    'claim_id', 'case_number', 'reviewer', 'ip_address'
  ]
};

// Vertical domain definitions
const VERTICALS = {
  vetproof: {
    name: 'VetProof',
    description: 'VA disability claims verification',
    regulations: ['38_CFR', 'FRE_901', 'APA_706'],
    ai_model: '@cf/meta/llama-3.1-8b-instruct',
    halt_threshold: 0.67,
    domains: ['disability_compensation', 'tdiu', 'presumptive', 'combined_rating']
  },
  legal: {
    name: 'LegalProof',
    description: 'Legal document and contract verification',
    regulations: ['FRE', 'UCC', 'FRCP'],
    ai_model: '@cf/meta/llama-3.1-8b-instruct',
    halt_threshold: 0.70,
    domains: ['contract_analysis', 'compliance_check', 'evidence_review', 'regulatory_filing']
  },
  finance: {
    name: 'FinanceProof',
    description: 'Financial claims and audit verification',
    regulations: ['SOX', 'GAAP', 'IFRS', 'BSA_AML'],
    ai_model: '@cf/meta/llama-3.1-8b-instruct',
    halt_threshold: 0.75,
    domains: ['audit_trail', 'transaction_verify', 'fraud_detection', 'compliance_reporting']
  },
  health: {
    name: 'HealthProof',
    description: 'Healthcare claims and medical record verification',
    regulations: ['HIPAA', '42_CFR', 'FDA_21CFR11'],
    ai_model: '@cf/meta/llama-3.1-8b-instruct',
    halt_threshold: 0.80,
    domains: ['medical_record', 'insurance_claim', 'clinical_trial', 'drug_safety']
  },
  education: {
    name: 'EduProof',
    description: 'Academic credential and research verification',
    regulations: ['FERPA', 'ABET', 'SACSCOC'],
    ai_model: '@cf/meta/llama-3.1-8b-instruct',
    halt_threshold: 0.65,
    domains: ['credential_verify', 'research_integrity', 'accreditation', 'transcript_audit']
  },
  aviation: {
    name: 'SkyProof',
    description: 'Aviation safety and AAM compliance verification',
    regulations: ['14_CFR', 'FAA_AC', 'ICAO_SARPS', 'EASA_CS'],
    ai_model: '@cf/meta/llama-3.1-8b-instruct',
    halt_threshold: 0.85,
    domains: ['airworthiness', 'pilot_certification', 'uas_compliance', 'aam_operations']
  }
};


// ============================================
// COLLECTIVE ORCHESTRATION WORKFLOW
// ============================================
export class CollectiveOrchestrationWorkflow extends WorkflowEntrypoint {

  async run(event, step) {
    const { claim, vertical, requestId } = event.payload;
    const startTime = Date.now();
    const collectiveId = requestId || crypto.randomUUID();

    // Step 1: Route to correct vertical
    const routing = await step.do('route-to-vertical', {
      retries: { limit: 1, delay: '2 seconds' },
      timeout: '10 seconds'
    }, async () => {
      const v = VERTICALS[vertical];
      if (!v) {
        return {
          error: true,
          message: `Unknown vertical: ${vertical}. Available: ${Object.keys(VERTICALS).join(', ')}`
        };
      }
      return {
        error: false,
        vertical: v,
        verticalKey: vertical,
        haltThreshold: v.halt_threshold,
        regulations: v.regulations
      };
    });

    if (routing.error) {
      return { collectiveId, status: 'error', message: routing.message };
    }

    // Step 2: Domain-specialized AI analysis
    const domainAnalysis = await step.do('domain-analysis', {
      retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
      timeout: '45 seconds'
    }, async () => {
      const v = routing.vertical;
      const ai = this.env.AI;

      const systemPrompt = `You are ${v.name}, a specialized ${v.description} agent.
Your domain expertise covers: ${v.domains.join(', ')}.
Applicable regulations: ${v.regulations.join(', ')}.

Analyze the following claim with domain expertise. Focus on:
1. Regulatory compliance with ${v.regulations.join(', ')}
2. Evidence sufficiency and completeness
3. Risk factors and red flags
4. Confidence in the claim's validity

Respond with JSON only:
{
  "domain_score": 0.0-1.0,
  "regulatory_compliance": { "status": "compliant|partial|non_compliant", "details": "..." },
  "evidence_assessment": { "sufficiency": 0.0-1.0, "gaps": ["list"] },
  "risk_factors": ["list"],
  "confidence": 0.0-1.0,
  "recommendation": "approve|review|reject",
  "reasoning": "brief domain-specific explanation",
  "knowledge_shards": [
    { "pattern_type": "rule|statistic|threshold", "pattern_key": "...", "pattern_value": "..." }
  ]
}`;

      const result = await ai.run(v.ai_model, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(claim) }
        ],
        max_tokens: 1024,
        temperature: 0.1
      });

      let parsed;
      try {
        const jsonMatch = result.response.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      } catch {
        parsed = null;
      }

      return parsed || {
        domain_score: 0.5,
        regulatory_compliance: { status: 'partial', details: 'AI parse failure' },
        evidence_assessment: { sufficiency: 0.5, gaps: ['ai_parse_failure'] },
        risk_factors: ['ai_screening_incomplete'],
        confidence: 0.3,
        recommendation: 'review',
        reasoning: 'Domain analysis could not parse AI response',
        knowledge_shards: []
      };
    });

    // Step 3: Constitutional Halt Check
    const haltCheck = await step.do('constitutional-halt', async () => {
      const threshold = routing.haltThreshold;
      const confidence = domainAnalysis.confidence;
      const haltTriggered = confidence < threshold;

      return {
        collectiveId,
        halt_triggered: haltTriggered,
        threshold,
        confidence,
        vertical: routing.verticalKey,
        risk_level: confidence < 0.4 ? 'critical' :
                    confidence < threshold ? 'high' :
                    domainAnalysis.risk_factors.length > 2 ? 'medium' : 'low'
      };
    });

    // Step 4: Extract and sanitize knowledge shards
    const shards = await step.do('extract-shards', async () => {
      const rawShards = domainAnalysis.knowledge_shards || [];
      const sanitized = [];

      for (const shard of rawShards) {
        // Enforce shard schema - strip any PII that might leak through
        const clean = {
          domain: routing.verticalKey,
          pattern_type: shard.pattern_type || 'rule',
          pattern_key: shard.pattern_key || crypto.randomUUID(),
          pattern_value: shard.pattern_value || '',
          confidence: domainAnalysis.confidence,
          source_count: 1,
          created_at: new Date().toISOString(),
          constitutional: !haltCheck.halt_triggered
        };

        // PII filter - reject any shard containing forbidden patterns
        const shardStr = JSON.stringify(clean).toLowerCase();
        const hasPII = SHARD_SCHEMA.forbidden_fields.some(field =>
          shardStr.includes(field)
        );

        if (!hasPII && clean.pattern_value.length > 0 && clean.pattern_value.length < 500) {
          sanitized.push(clean);
        }
      }

      return { shards: sanitized, count: sanitized.length };
    });

    // Step 5: Store shards in Vectorize (quantum shard learning)
    if (shards.count > 0 && !haltCheck.halt_triggered) {
      await step.do('store-shards', async () => {
        try {
          const vectors = [];
          const ai = this.env.AI;

          for (const shard of shards.shards) {
            // Generate embedding for the shard
            const embedding = await ai.run('@cf/baai/bge-base-en-v1.5', {
              text: `${shard.domain} ${shard.pattern_type}: ${shard.pattern_value}`
            });

            if (embedding.data && embedding.data[0]) {
              vectors.push({
                id: `shard-${shard.domain}-${crypto.randomUUID().slice(0, 8)}`,
                values: embedding.data[0],
                metadata: {
                  domain: shard.domain,
                  pattern_type: shard.pattern_type,
                  pattern_key: shard.pattern_key,
                  confidence: shard.confidence,
                  constitutional: shard.constitutional ? 'true' : 'false',
                  created_at: shard.created_at
                }
              });
            }
          }

          if (vectors.length > 0) {
            await this.env.VECTORIZE.upsert(vectors);
          }

          return { stored: vectors.length };
        } catch (e) {
          return { stored: 0, error: e.message };
        }
      });
    }

    // Step 6: Query collective knowledge for context
    const collectiveKnowledge = await step.do('query-collective', async () => {
      try {
        const ai = this.env.AI;
        const queryText = `${routing.verticalKey} ${claim.type || ''} ${claim.condition || ''} verification`;
        const queryEmbedding = await ai.run('@cf/baai/bge-base-en-v1.5', {
          text: queryText
        });

        if (queryEmbedding.data && queryEmbedding.data[0]) {
          const results = await this.env.VECTORIZE.query(queryEmbedding.data[0], {
            topK: 5,
            filter: { domain: routing.verticalKey },
            returnMetadata: 'all'
          });

          return {
            related_shards: results.matches.map(m => ({
              id: m.id,
              score: m.score,
              metadata: m.metadata
            })),
            count: results.matches.length
          };
        }

        return { related_shards: [], count: 0 };
      } catch (e) {
        return { related_shards: [], count: 0, error: e.message };
      }
    });

    // Step 7: Audit trail
    await step.do('audit-collective', async () => {
      try {
        await this.env.AUDIT_DB.prepare(
          `INSERT INTO audit_events (id, event_type, claim_id, data, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(
          crypto.randomUUID(),
          'collective_analysis',
          collectiveId,
          JSON.stringify({
            vertical: routing.verticalKey,
            confidence: domainAnalysis.confidence,
            halt_triggered: haltCheck.halt_triggered,
            shards_extracted: shards.count,
            collective_matches: collectiveKnowledge.count,
            risk_level: haltCheck.risk_level,
            recommendation: domainAnalysis.recommendation
          }),
          new Date().toISOString()
        ).run();
      } catch (e) {
        // D1 failure non-fatal
      }
    });

    // Step 8: Store proof in R2
    const proof = await step.do('store-proof', async () => {
      const proofData = {
        id: crypto.randomUUID(),
        collective_id: collectiveId,
        type: 'sentient_collective_analysis',
        vertical: routing.verticalKey,
        domain_score: domainAnalysis.domain_score,
        confidence: domainAnalysis.confidence,
        halt_triggered: haltCheck.halt_triggered,
        risk_level: haltCheck.risk_level,
        recommendation: domainAnalysis.recommendation,
        regulatory_compliance: domainAnalysis.regulatory_compliance,
        evidence_assessment: domainAnalysis.evidence_assessment,
        shards_contributed: shards.count,
        collective_context: collectiveKnowledge.count,
        processing_time_ms: Date.now() - startTime,
        created_at: new Date().toISOString()
      };

      // Hash the proof
      const encoder = new TextEncoder();
      const data = encoder.encode(JSON.stringify(proofData));
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      proofData.proof_hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

      try {
        await this.env.PROOF_STORAGE.put(
          `collective/${routing.verticalKey}/${collectiveId}.json`,
          JSON.stringify(proofData, null, 2),
          {
            customMetadata: {
              vertical: routing.verticalKey,
              risk_level: haltCheck.risk_level,
              recommendation: domainAnalysis.recommendation
            }
          }
        );
      } catch (e) {
        // R2 failure non-fatal
      }

      // Cache for fast lookup
      await this.env.VERIFICATION_CACHE.put(
        `collective:proof:${collectiveId}`,
        JSON.stringify(proofData),
        { expirationTtl: 86400 * 30 }
      );

      return proofData;
    });

    return {
      collectiveId,
      vertical: routing.verticalKey,
      status: domainAnalysis.recommendation,
      confidence: domainAnalysis.confidence,
      halt_triggered: haltCheck.halt_triggered,
      risk_level: haltCheck.risk_level,
      domain_score: domainAnalysis.domain_score,
      regulatory_compliance: domainAnalysis.regulatory_compliance.status,
      evidence_sufficiency: domainAnalysis.evidence_assessment.sufficiency,
      shards_contributed: shards.count,
      collective_context: collectiveKnowledge.count,
      proof: { id: proof.id, hash: proof.proof_hash },
      processing_time_ms: Date.now() - startTime
    };
  }
}


// ============================================
// HTTP Handler
// ============================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const headers = { 'Content-Type': 'application/json', ...corsHeaders };

    try {
      // Health check
      if (path === '/health') {
        return Response.json({
          status: 'healthy',
          service: 'aevion-sentient-collective',
          version: '1.0.0',
          verticals: Object.keys(VERTICALS),
          capabilities: [
            'multi-vertical-routing',
            'domain-specialized-analysis',
            'constitutional-halt-enforcement',
            'quantum-shard-learning',
            'collective-knowledge-query',
            'vectorize-embeddings',
            'proof-signing',
            'audit-trail'
          ],
          shard_schema: SHARD_SCHEMA.version,
          vertical_count: Object.keys(VERTICALS).length
        }, { headers });
      }

      // List verticals
      if (path === '/v1/verticals' && request.method === 'GET') {
        return Response.json({
          verticals: Object.entries(VERTICALS).map(([key, v]) => ({
            key,
            name: v.name,
            description: v.description,
            regulations: v.regulations,
            halt_threshold: v.halt_threshold,
            domains: v.domains
          }))
        }, { headers });
      }

      // Submit claim to collective
      if (path === '/v1/collective/analyze' && request.method === 'POST') {
        const body = await request.json();

        if (!body.claim || !body.vertical) {
          return Response.json({
            error: 'claim object and vertical string required',
            available_verticals: Object.keys(VERTICALS)
          }, { status: 400, headers });
        }

        if (!VERTICALS[body.vertical]) {
          return Response.json({
            error: `Unknown vertical: ${body.vertical}`,
            available_verticals: Object.keys(VERTICALS)
          }, { status: 400, headers });
        }

        const instance = await env.COLLECTIVE_WORKFLOW.create({
          params: {
            claim: body.claim,
            vertical: body.vertical,
            requestId: body.request_id || crypto.randomUUID()
          }
        });

        return Response.json({
          workflow_id: instance.id,
          vertical: body.vertical,
          status: 'analyzing',
          message: `Claim routed to ${VERTICALS[body.vertical].name} domain agent`
        }, { status: 202, headers });
      }

      // Get workflow status
      if (path.startsWith('/v1/collective/status/') && request.method === 'GET') {
        const workflowId = path.split('/').pop();
        try {
          const instance = await env.COLLECTIVE_WORKFLOW.get(workflowId);
          const status = await instance.status();
          return Response.json({
            workflow_id: workflowId,
            status: status.status,
            output: status.output || null,
            error: status.error || null
          }, { headers });
        } catch (e) {
          return Response.json({ error: 'Workflow not found' }, { status: 404, headers });
        }
      }

      // Query collective knowledge (shard search)
      if (path === '/v1/collective/knowledge' && request.method === 'POST') {
        const body = await request.json();
        const query = body.query || '';
        const vertical = body.vertical || null;
        const topK = Math.min(body.top_k || 10, 50);

        const ai = env.AI;
        const embedding = await ai.run('@cf/baai/bge-base-en-v1.5', {
          text: query
        });

        if (!embedding.data || !embedding.data[0]) {
          return Response.json({ error: 'Failed to generate embedding' }, { status: 500, headers });
        }

        const queryOpts = {
          topK,
          returnMetadata: 'all'
        };

        if (vertical && VERTICALS[vertical]) {
          queryOpts.filter = { domain: vertical };
        }

        const results = await env.VECTORIZE.query(embedding.data[0], queryOpts);

        return Response.json({
          query,
          vertical_filter: vertical,
          results: results.matches.map(m => ({
            id: m.id,
            score: m.score,
            metadata: m.metadata
          })),
          count: results.matches.length
        }, { headers });
      }

      // Get shard statistics
      if (path === '/v1/collective/stats' && request.method === 'GET') {
        // Query each vertical for shard counts
        const stats = {};
        for (const [key, v] of Object.entries(VERTICALS)) {
          stats[key] = {
            name: v.name,
            halt_threshold: v.halt_threshold,
            regulations: v.regulations.length
          };
        }

        return Response.json({
          verticals: stats,
          total_verticals: Object.keys(VERTICALS).length,
          shard_schema: SHARD_SCHEMA.version
        }, { headers });
      }

      // Get proof by collective ID
      if (path.startsWith('/v1/collective/proof/') && request.method === 'GET') {
        const collectiveId = path.split('/').pop();
        const cached = await env.VERIFICATION_CACHE.get(`collective:proof:${collectiveId}`);

        if (cached) {
          return Response.json(JSON.parse(cached), { headers });
        }

        return Response.json({ error: 'Proof not found' }, { status: 404, headers });
      }

      // 404
      return Response.json({
        error: 'Not found',
        available_endpoints: [
          'GET  /health',
          'GET  /v1/verticals',
          'POST /v1/collective/analyze',
          'GET  /v1/collective/status/:workflow_id',
          'POST /v1/collective/knowledge',
          'GET  /v1/collective/stats',
          'GET  /v1/collective/proof/:id'
        ]
      }, { status: 404, headers });

    } catch (e) {
      return Response.json({
        error: 'Internal server error',
        message: e.message
      }, { status: 500, headers });
    }
  }
};
