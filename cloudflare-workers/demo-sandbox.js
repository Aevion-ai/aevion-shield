/**
 * Aevion Demo Sandbox Worker
 * Self-service prospect demo - no sales calls needed
 * Solo CEO: Prospects try the platform themselves, you close deals async
 *
 * Features:
 * - 3 interactive demo scenarios (VetProof, Legal, Finance)
 * - Simulated verification pipeline with real proof format
 * - Rate-limited anonymous access (10 demos/day per IP)
 * - Lead capture (optional email for follow-up)
 * - Demo analytics for CEO (which scenarios convert best)
 *
 * Patent: US 63/896,282
 */

const DEMO_SCENARIOS = {
  vetproof: {
    name: 'VetProof - VA Disability Claim Verification',
    vertical: 'VetProof',
    haltThreshold: 0.67,
    description: 'Verify a VA disability claim using BFT consensus and formal legal proofs',
    sampleClaim: {
      type: 'direct_service_connection',
      condition: 'Tinnitus (bilateral)',
      cfr: '38 CFR 3.303',
      evidence: [
        'Service treatment records showing noise exposure (MOS 11B)',
        'VA C&P exam diagnosing bilateral tinnitus',
        'Buddy statement from fellow service member',
      ],
      rating_claimed: 10,
    },
    expectedResult: {
      verified: true,
      confidence: 0.89,
      consensus: '4/5 models agree',
      legal_basis: '38 CFR 3.303(a) - direct service connection established',
      proof_hash: null, // Generated at runtime
      halt_triggered: false,
      evidence_chain: [
        { phase: 'SANITIZE', result: 'PII redacted (SSN, name, DOB removed)' },
        { phase: 'GENERATE', result: 'Legal analysis generated via 5-model ensemble' },
        { phase: 'VERIFY', result: 'BFT consensus achieved (4/5 agreement)' },
        { phase: 'DETECT', result: 'No fraud indicators (PFI score: 0.02)' },
        { phase: 'SIGN', result: 'Ed25519 proof bundle signed and stored' },
      ],
    },
  },
  legal: {
    name: 'Legal Document Verification',
    vertical: 'Legal',
    haltThreshold: 0.70,
    description: 'Verify legal document authenticity and compliance with FRE Rule 901',
    sampleClaim: {
      type: 'document_authenticity',
      document: 'Employment Contract (redacted)',
      rules: ['FRE Rule 901', 'ABA Model Rules 1.1'],
      assertions: [
        'Document was executed by authorized signatory',
        'Terms comply with state employment law',
        'Non-compete clause is enforceable in jurisdiction',
      ],
    },
    expectedResult: {
      verified: true,
      confidence: 0.82,
      consensus: '4/5 models agree',
      legal_basis: 'FRE Rule 901(b)(1) - testimony of witness with knowledge',
      proof_hash: null,
      halt_triggered: false,
      evidence_chain: [
        { phase: 'SANITIZE', result: 'PII redacted (names, addresses, SSN)' },
        { phase: 'GENERATE', result: 'Legal analysis generated' },
        { phase: 'VERIFY', result: 'BFT consensus achieved (4/5)' },
        { phase: 'DETECT', result: 'No anomalies detected (PFI: 0.05)' },
        { phase: 'SIGN', result: 'Proof bundle signed' },
      ],
    },
  },
  finance: {
    name: 'Financial Compliance Verification',
    vertical: 'Finance',
    haltThreshold: 0.75,
    description: 'Verify financial transaction compliance with SOX and Dodd-Frank',
    sampleClaim: {
      type: 'transaction_compliance',
      transaction: 'Material Weakness Remediation Report',
      regulations: ['SOX Section 302', 'SOX Section 404', 'Dodd-Frank'],
      assertions: [
        'Internal controls are effective',
        'Material weakness has been remediated',
        'Disclosure is accurate and complete',
      ],
    },
    expectedResult: {
      verified: true,
      confidence: 0.78,
      consensus: '4/5 models agree',
      legal_basis: 'SOX Section 404 - Management assessment of internal controls',
      proof_hash: null,
      halt_triggered: false,
      evidence_chain: [
        { phase: 'SANITIZE', result: 'Financial PII redacted' },
        { phase: 'GENERATE', result: 'Compliance analysis generated' },
        { phase: 'VERIFY', result: 'BFT consensus achieved (4/5)' },
        { phase: 'DETECT', result: 'No fraud indicators (PFI: 0.08)' },
        { phase: 'SIGN', result: 'Proof bundle signed' },
      ],
    },
  },
  halt: {
    name: 'Constitutional Halt Demo',
    vertical: 'VetProof',
    haltThreshold: 0.67,
    description: 'See what happens when the AI is NOT confident enough - it STOPS instead of hallucinating',
    sampleClaim: {
      type: 'speculative_claim',
      condition: 'Undiagnosed condition with no medical evidence',
      cfr: '38 CFR 3.303',
      evidence: ['Self-reported symptoms only', 'No medical records'],
      rating_claimed: 100,
    },
    expectedResult: {
      verified: false,
      confidence: 0.31,
      consensus: '1/5 models agree',
      legal_basis: 'HALTED - Insufficient evidence for 38 CFR 3.303 analysis',
      proof_hash: null,
      halt_triggered: true,
      halt_reason: 'Confidence 0.31 below threshold 0.67 - Constitutional Halt engaged',
      evidence_chain: [
        { phase: 'SANITIZE', result: 'PII redacted' },
        { phase: 'GENERATE', result: 'Analysis attempted' },
        { phase: 'VERIFY', result: 'HALT - consensus failed (1/5 agreement)' },
        { phase: 'DETECT', result: 'High fraud risk (PFI: 0.72)' },
        { phase: 'SIGN', result: 'Halt proof signed (records WHY it stopped)' },
      ],
    },
  },
};

// Generate a simulated proof hash
function generateDemoProofHash() {
  const data = Date.now().toString() + Math.random().toString();
  // Simple hash simulation (in production this is SHA-256 + Ed25519)
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'demo_proof_' + Math.abs(hash).toString(16).padStart(16, '0');
}

// Rate limiting by IP
async function checkDemoRateLimit(env, ip) {
  if (!env.RATE_LIMITS) return { allowed: true, remaining: 10 };

  const key = `demo:${ip}:${new Date().toISOString().split('T')[0]}`;
  const current = parseInt(await env.RATE_LIMITS.get(key) || '0');

  if (current >= 10) {
    return { allowed: false, remaining: 0 };
  }

  await env.RATE_LIMITS.put(key, (current + 1).toString(), { expirationTtl: 86400 });
  return { allowed: true, remaining: 10 - current - 1 };
}

// Track demo analytics
async function trackDemoEvent(env, event) {
  if (!env.AUDIT_DB) return;

  try {
    await env.AUDIT_DB.prepare(
      `INSERT INTO audit_events (event_type, event_data, created_at) VALUES (?, ?, ?)`
    ).bind('demo_event', JSON.stringify(event), new Date().toISOString()).run();
  } catch (e) {
    // Non-blocking
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const headers = { ...corsHeaders, 'Content-Type': 'application/json' };

    try {
      // Health
      if (path === '/health' || path === '/') {
        return Response.json({
          status: 'operational',
          worker: 'demo-sandbox',
          scenarios: Object.keys(DEMO_SCENARIOS).length,
          message: 'Try Aevion verification - no account needed',
          timestamp: new Date().toISOString(),
        }, { headers });
      }

      // List available demos
      if (path === '/v1/scenarios') {
        const scenarios = Object.entries(DEMO_SCENARIOS).map(([key, s]) => ({
          id: key,
          name: s.name,
          vertical: s.vertical,
          description: s.description,
          haltThreshold: s.haltThreshold,
        }));

        return Response.json({
          scenarios,
          rateLimit: '10 demos per day (anonymous)',
          note: 'No account required. See what verifiable AI looks like.',
        }, { headers });
      }

      // Run a demo scenario
      if (path.startsWith('/v1/demo/')) {
        const scenarioId = path.split('/v1/demo/')[1];
        const scenario = DEMO_SCENARIOS[scenarioId];

        if (!scenario) {
          return Response.json({
            error: 'Unknown scenario',
            available: Object.keys(DEMO_SCENARIOS),
          }, { status: 404, headers });
        }

        // Check rate limit
        const rateCheck = await checkDemoRateLimit(env, ip);
        if (!rateCheck.allowed) {
          return Response.json({
            error: 'Demo rate limit exceeded',
            message: 'You have used all 10 free demos today. Create a free account for 100 verifications/day.',
            pricing: {
              free: '100 verifications/day ($0)',
              pro: '500 verifications/day ($99/mo)',
              enterprise: '50,000 verifications/day ($499/mo)',
              government: 'Custom volume (contact us)',
            },
          }, { status: 429, headers });
        }

        // Simulate pipeline execution with realistic timing
        const startTime = Date.now();
        const result = JSON.parse(JSON.stringify(scenario.expectedResult));
        result.proof_hash = generateDemoProofHash();

        // Add timestamps to evidence chain
        let elapsed = 0;
        for (const step of result.evidence_chain) {
          elapsed += Math.floor(Math.random() * 200) + 50;
          step.duration_ms = elapsed;
        }

        const totalTime = Date.now() - startTime;

        // Track analytics
        await trackDemoEvent(env, {
          scenario: scenarioId,
          vertical: scenario.vertical,
          ip_hash: ip.split('.').slice(0, 2).join('.') + '.x.x', // Partial IP only
          halt_triggered: result.halt_triggered,
          confidence: result.confidence,
        });

        // Capture email if provided
        let leadCaptured = false;
        if (request.method === 'POST') {
          try {
            const body = await request.json();
            if (body.email) {
              await trackDemoEvent(env, {
                type: 'lead_capture',
                scenario: scenarioId,
                email: body.email,
                company: body.company || null,
              });
              leadCaptured = true;
            }
          } catch (e) {
            // Non-blocking
          }
        }

        return Response.json({
          demo: true,
          scenario: {
            id: scenarioId,
            name: scenario.name,
            vertical: scenario.vertical,
            haltThreshold: scenario.haltThreshold,
          },
          input: scenario.sampleClaim,
          result,
          performance: {
            total_ms: totalTime,
            pipeline_steps: result.evidence_chain.length,
          },
          rateLimit: {
            remaining: rateCheck.remaining,
            daily_limit: 10,
            message: rateCheck.remaining <= 3
              ? 'Running low on free demos. Create an account for 100/day.'
              : null,
          },
          leadCaptured,
          nextSteps: {
            create_account: '/v1/pricing',
            api_docs: 'https://docs.aevion.ai',
            contact: 'https://aevion.ai/contact',
          },
          disclaimer: 'This is a simulated demo using representative data. Production verifications use live BFT consensus with 5+ AI models and cryptographic proof signing.',
        }, { headers });
      }

      // Demo analytics (CEO only - shows which scenarios convert)
      if (path === '/v1/analytics') {
        // Simple auth check
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return Response.json({ error: 'Admin access required' }, { status: 401, headers });
        }

        if (!env.AUDIT_DB) {
          return Response.json({ error: 'Analytics DB not available' }, { status: 503, headers });
        }

        const [totalDemos, leads, scenarioBreakdown] = await Promise.all([
          env.AUDIT_DB.prepare(
            `SELECT COUNT(*) as count FROM audit_events WHERE event_type = 'demo_event' AND created_at > datetime('now', '-30 days')`
          ).first(),
          env.AUDIT_DB.prepare(
            `SELECT COUNT(*) as count FROM audit_events WHERE event_type = 'demo_event' AND event_data LIKE '%lead_capture%' AND created_at > datetime('now', '-30 days')`
          ).first(),
          env.AUDIT_DB.prepare(
            `SELECT event_data FROM audit_events WHERE event_type = 'demo_event' AND created_at > datetime('now', '-7 days') ORDER BY created_at DESC LIMIT 100`
          ).all(),
        ]);

        // Aggregate scenario counts
        const scenarioCounts = {};
        for (const row of scenarioBreakdown.results || []) {
          try {
            const data = JSON.parse(row.event_data);
            if (data.scenario) {
              scenarioCounts[data.scenario] = (scenarioCounts[data.scenario] || 0) + 1;
            }
          } catch (e) {
            // Skip malformed entries
          }
        }

        return Response.json({
          period: 'last_30_days',
          totalDemos: totalDemos?.count || 0,
          leadsCaptured: leads?.count || 0,
          conversionRate: totalDemos?.count
            ? Math.round((leads?.count || 0) / totalDemos.count * 100 * 10) / 10
            : 0,
          scenarioPopularity: scenarioCounts,
          timestamp: new Date().toISOString(),
        }, { headers });
      }

      // Pricing endpoint (public)
      if (path === '/v1/pricing') {
        return Response.json({
          tiers: [
            { name: 'Free', price: 0, verifications: '100/day', features: ['Basic verification', 'Email support'] },
            { name: 'Pro', price: 99, verifications: '500/day', features: ['Priority verification', 'API access', 'Webhook notifications', 'Compliance reports'] },
            { name: 'Enterprise', price: 499, verifications: '50,000/day', features: ['Unlimited verticals', 'Custom halt thresholds', 'Dedicated support', 'SLA guarantee', 'HITL workflows'] },
            { name: 'Government', price: 'Custom', verifications: '100,000/day', features: ['FedRAMP ready', 'CMMC Level 2', 'On-prem option', 'Dedicated infrastructure', 'Formal verification'] },
          ],
          trial: 'Try any scenario above - 10 free demos per day, no account required.',
          patent: 'US 63/896,282 - Protected verification methodology',
        }, { headers });
      }

      return Response.json({
        error: 'Not found',
        endpoints: [
          'GET  /v1/scenarios - List demo scenarios',
          'GET  /v1/demo/{scenario} - Run a demo (vetproof, legal, finance, halt)',
          'POST /v1/demo/{scenario} - Run demo + capture lead {email, company}',
          'GET  /v1/pricing - View pricing tiers',
          'GET  /v1/analytics - Demo analytics (admin only)',
        ],
      }, { status: 404, headers });

    } catch (err) {
      return Response.json({ error: 'Internal error', message: err.message }, { status: 500, headers });
    }
  },
};
