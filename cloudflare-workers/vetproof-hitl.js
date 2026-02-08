/**
 * Aevion VetProof HITL (Human-in-the-Loop) Approval Worker
 *
 * Implements durable Workflow-based human approval gates for VetProof claims.
 * Uses Cloudflare Workflows with waitForEvent() for external approval signals.
 *
 * Patent: US 63/896,282 - Constitutional Halt + Human Oversight
 *
 * Flow:
 *   1. Claim submitted -> workflow starts
 *   2. AI pre-screening (Workers AI)
 *   3. Risk scoring (Constitutional Halt threshold check)
 *   4. IF high-risk OR low-confidence -> HITL gate (waitForEvent)
 *   5. Human reviewer approves/rejects via API or WebSocket
 *   6. Approved claims -> proof signing + D1 audit
 *   7. Rejected claims -> feedback loop + audit
 */

import { WorkflowEntrypoint } from 'cloudflare:workers';

// ============================================
// HITL Approval Workflow (Durable Execution)
// ============================================
export class HITLApprovalWorkflow extends WorkflowEntrypoint {

  async run(event, step) {
    const { claim, submittedBy, priority } = event.payload;
    const claimId = claim.id || crypto.randomUUID();
    const startTime = Date.now();

    // Step 1: AI Pre-Screening
    const screening = await step.do('ai-pre-screen', {
      retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
      timeout: '30 seconds'
    }, async () => {
      const ai = this.env.AI;

      const prompt = `You are a VA disability claims analyst. Analyze this claim for completeness and validity.

Claim Type: ${claim.type || 'disability_compensation'}
Condition: ${claim.condition || 'unspecified'}
Evidence Summary: ${claim.evidence_summary || 'none provided'}
Service Connection: ${claim.service_connection || 'unknown'}

Respond with JSON only:
{
  "completeness_score": 0.0-1.0,
  "risk_flags": ["list of concerns"],
  "recommended_action": "approve|review|reject",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}`;

      const result = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
        prompt,
        max_tokens: 512,
        temperature: 0.1
      });

      let parsed;
      try {
        const jsonMatch = result.response.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      } catch {
        parsed = null;
      }

      return {
        claimId,
        raw_response: result.response,
        screening: parsed || {
          completeness_score: 0.5,
          risk_flags: ['ai_parse_failure'],
          recommended_action: 'review',
          confidence: 0.3,
          reasoning: 'AI screening could not parse response - defaulting to human review'
        },
        timestamp: new Date().toISOString()
      };
    });

    // Step 2: Risk Assessment (Constitutional Halt Check)
    const riskAssessment = await step.do('risk-assessment', async () => {
      const s = screening.screening;
      const haltThreshold = parseFloat(this.env.HALT_THRESHOLD || '0.67');

      const requiresHumanReview =
        s.recommended_action === 'review' ||
        s.recommended_action === 'reject' ||
        s.confidence < haltThreshold ||
        s.completeness_score < 0.6 ||
        s.risk_flags.length > 2 ||
        (priority === 'high') ||
        (claim.type === 'tdiu') ||
        (claim.disability_rating && parseInt(claim.disability_rating) >= 70);

      return {
        claimId,
        requires_human_review: requiresHumanReview,
        risk_level: s.confidence < 0.4 ? 'critical' :
                    s.confidence < haltThreshold ? 'high' :
                    s.risk_flags.length > 0 ? 'medium' : 'low',
        halt_triggered: s.confidence < haltThreshold,
        screening_summary: {
          completeness: s.completeness_score,
          confidence: s.confidence,
          action: s.recommended_action,
          flags: s.risk_flags
        }
      };
    });

    // Step 3: Audit the screening result
    await step.do('audit-screening', async () => {
      try {
        await this.env.AUDIT_DB.prepare(
          `INSERT INTO audit_events (id, event_type, claim_id, data, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(
          crypto.randomUUID(),
          'hitl_screening',
          claimId,
          JSON.stringify({
            screening: screening.screening,
            risk: riskAssessment,
            submitted_by: submittedBy
          }),
          new Date().toISOString()
        ).run();
      } catch (e) {
        // D1 failure is non-fatal
      }
    });

    // Step 4: HITL Gate (if required)
    let approvalResult;
    if (riskAssessment.requires_human_review) {
      // Cache the pending review for the API to serve
      await step.do('cache-pending-review', async () => {
        await this.env.VERIFICATION_CACHE.put(
          `hitl:pending:${claimId}`,
          JSON.stringify({
            claimId,
            claim,
            screening: screening.screening,
            risk: riskAssessment,
            submitted_by: submittedBy,
            submitted_at: new Date().toISOString(),
            status: 'awaiting_review'
          }),
          { expirationTtl: 86400 * 7 } // 7 days TTL
        );

        // Add to pending queue index
        const pendingList = JSON.parse(
          await this.env.VERIFICATION_CACHE.get('hitl:pending:index') || '[]'
        );
        pendingList.push({
          claimId,
          risk_level: riskAssessment.risk_level,
          submitted_at: new Date().toISOString()
        });
        // Keep only last 100 pending
        const trimmed = pendingList.slice(-100);
        await this.env.VERIFICATION_CACHE.put(
          'hitl:pending:index',
          JSON.stringify(trimmed),
          { expirationTtl: 86400 * 7 }
        );
      });

      // Wait for human approval (up to 7 days)
      approvalResult = await step.waitForEvent('human-approval', {
        timeout: '7 days',
        type: `claim-review-${claimId}`
      });

      // Clean up pending cache
      await step.do('cleanup-pending', async () => {
        await this.env.VERIFICATION_CACHE.delete(`hitl:pending:${claimId}`);
      });

    } else {
      // Auto-approve low-risk claims
      approvalResult = {
        payload: {
          decision: 'approved',
          reviewer: 'auto-approve',
          reason: `Low risk (confidence: ${riskAssessment.screening_summary.confidence}, flags: ${riskAssessment.screening_summary.flags.length})`,
          auto: true
        }
      };
    }

    // Step 5: Process Decision
    const decision = approvalResult.payload || approvalResult;
    const isApproved = decision.decision === 'approved';

    // Step 6: Sign Proof (if approved)
    let proof = null;
    if (isApproved) {
      proof = await step.do('sign-proof', async () => {
        const proofData = {
          id: crypto.randomUUID(),
          claim_id: claimId,
          type: 'vetproof_hitl_approved',
          claim_type: claim.type || 'disability_compensation',
          condition: claim.condition,
          screening_confidence: screening.screening.confidence,
          risk_level: riskAssessment.risk_level,
          reviewer: decision.reviewer || 'auto-approve',
          auto_approved: decision.auto || false,
          approved_at: new Date().toISOString(),
          constitutional_halt: riskAssessment.halt_triggered,
          processing_time_ms: Date.now() - startTime
        };

        // Hash the proof
        const encoder = new TextEncoder();
        const data = encoder.encode(JSON.stringify(proofData));
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        proofData.proof_hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        // Store in R2
        try {
          await this.env.PROOF_STORAGE.put(
            `hitl/${claimId}/${proofData.id}.json`,
            JSON.stringify(proofData, null, 2),
            {
              customMetadata: {
                claim_id: claimId,
                type: 'hitl_approved',
                risk_level: riskAssessment.risk_level
              }
            }
          );
        } catch (e) {
          // R2 failure is non-fatal
        }

        // Cache proof for fast lookup
        await this.env.VERIFICATION_CACHE.put(
          `proof:hitl:${claimId}`,
          JSON.stringify(proofData),
          { expirationTtl: 86400 * 30 } // 30 days
        );

        return proofData;
      });
    }

    // Step 7: Final Audit
    await step.do('audit-decision', async () => {
      try {
        await this.env.AUDIT_DB.prepare(
          `INSERT INTO audit_events (id, event_type, claim_id, data, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(
          crypto.randomUUID(),
          isApproved ? 'hitl_approved' : 'hitl_rejected',
          claimId,
          JSON.stringify({
            decision: decision.decision,
            reviewer: decision.reviewer,
            reason: decision.reason,
            auto_approved: decision.auto || false,
            proof_hash: proof ? proof.proof_hash : null,
            processing_time_ms: Date.now() - startTime
          }),
          new Date().toISOString()
        ).run();
      } catch (e) {
        // D1 failure is non-fatal
      }
    });

    return {
      claimId,
      status: isApproved ? 'approved' : 'rejected',
      decision: decision.decision,
      reviewer: decision.reviewer || 'auto-approve',
      auto_approved: decision.auto || false,
      risk_level: riskAssessment.risk_level,
      halt_triggered: riskAssessment.halt_triggered,
      screening_confidence: screening.screening.confidence,
      proof: proof ? { id: proof.id, hash: proof.proof_hash } : null,
      processing_time_ms: Date.now() - startTime
    };
  }
}


// ============================================
// HTTP Handler (API Gateway for HITL)
// ============================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
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
      // Health Check
      if (path === '/health') {
        return Response.json({
          status: 'healthy',
          service: 'aevion-vetproof-hitl',
          version: '1.0.0',
          capabilities: [
            'hitl-approval-workflow',
            'ai-pre-screening',
            'risk-assessment',
            'constitutional-halt-gate',
            'proof-signing',
            'audit-trail',
            'pending-review-queue'
          ],
          thresholds: {
            halt: parseFloat(env.HALT_THRESHOLD || '0.67'),
            coherence: parseFloat(env.COHERENCE_THRESHOLD || '0.85')
          }
        }, { headers });
      }

      // Submit claim for HITL review
      if (path === '/v1/claims/submit' && request.method === 'POST') {
        const body = await request.json();

        if (!body.claim) {
          return Response.json({ error: 'claim object required' }, { status: 400, headers });
        }

        const instance = await env.HITL_WORKFLOW.create({
          params: {
            claim: body.claim,
            submittedBy: body.submitted_by || 'api',
            priority: body.priority || 'normal'
          }
        });

        return Response.json({
          workflow_id: instance.id,
          claim_id: body.claim.id || 'pending',
          status: 'submitted',
          message: 'Claim submitted for HITL review pipeline'
        }, { status: 202, headers });
      }

      // Get workflow status
      if (path.startsWith('/v1/claims/status/') && request.method === 'GET') {
        const workflowId = path.split('/').pop();

        try {
          const instance = await env.HITL_WORKFLOW.get(workflowId);
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

      // Approve a claim (sends event to waiting workflow)
      if (path === '/v1/claims/approve' && request.method === 'POST') {
        const apiKey = request.headers.get('X-API-Key') || request.headers.get('Authorization');
        if (!apiKey) {
          return Response.json({ error: 'Authorization required for approvals' }, { status: 401, headers });
        }

        const body = await request.json();
        if (!body.workflow_id || !body.claim_id) {
          return Response.json({ error: 'workflow_id and claim_id required' }, { status: 400, headers });
        }

        try {
          const instance = await env.HITL_WORKFLOW.get(body.workflow_id);
          await instance.sendEvent({
            type: `claim-review-${body.claim_id}`,
            payload: {
              decision: 'approved',
              reviewer: body.reviewer || 'unknown',
              reason: body.reason || 'Manual approval',
              notes: body.notes || '',
              approved_at: new Date().toISOString()
            }
          });

          return Response.json({
            status: 'approval_sent',
            workflow_id: body.workflow_id,
            claim_id: body.claim_id
          }, { headers });
        } catch (e) {
          return Response.json({ error: 'Failed to send approval', detail: e.message }, { status: 500, headers });
        }
      }

      // Reject a claim
      if (path === '/v1/claims/reject' && request.method === 'POST') {
        const apiKey = request.headers.get('X-API-Key') || request.headers.get('Authorization');
        if (!apiKey) {
          return Response.json({ error: 'Authorization required for rejections' }, { status: 401, headers });
        }

        const body = await request.json();
        if (!body.workflow_id || !body.claim_id) {
          return Response.json({ error: 'workflow_id and claim_id required' }, { status: 400, headers });
        }

        try {
          const instance = await env.HITL_WORKFLOW.get(body.workflow_id);
          await instance.sendEvent({
            type: `claim-review-${body.claim_id}`,
            payload: {
              decision: 'rejected',
              reviewer: body.reviewer || 'unknown',
              reason: body.reason || 'Manual rejection',
              notes: body.notes || '',
              rejected_at: new Date().toISOString()
            }
          });

          return Response.json({
            status: 'rejection_sent',
            workflow_id: body.workflow_id,
            claim_id: body.claim_id
          }, { headers });
        } catch (e) {
          return Response.json({ error: 'Failed to send rejection', detail: e.message }, { status: 500, headers });
        }
      }

      // List pending reviews
      if (path === '/v1/claims/pending' && request.method === 'GET') {
        const pendingIndex = JSON.parse(
          await env.VERIFICATION_CACHE.get('hitl:pending:index') || '[]'
        );

        // Enrich with claim details
        const enriched = [];
        for (const item of pendingIndex.slice(-20)) {
          const detail = await env.VERIFICATION_CACHE.get(`hitl:pending:${item.claimId}`);
          if (detail) {
            enriched.push(JSON.parse(detail));
          }
        }

        return Response.json({
          pending_count: enriched.length,
          claims: enriched
        }, { headers });
      }

      // Get proof by claim ID
      if (path.startsWith('/v1/proof/') && request.method === 'GET') {
        const claimId = path.split('/').pop();
        const cached = await env.VERIFICATION_CACHE.get(`proof:hitl:${claimId}`);

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
          'POST /v1/claims/submit',
          'GET  /v1/claims/status/:workflow_id',
          'POST /v1/claims/approve',
          'POST /v1/claims/reject',
          'GET  /v1/claims/pending',
          'GET  /v1/proof/:claim_id'
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
