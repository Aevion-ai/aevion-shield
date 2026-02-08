/**
 * Aevion Regulation Tracker Worker
 *
 * Scheduled (cron) worker that maintains a living regulatory database.
 * Tracks changes across multiple regulatory domains and feeds updates
 * into the SentientCore collective knowledge layer.
 *
 * This is part of the "deep moat" - cross-domain regulatory intelligence
 * that creates symbiotic connections between verticals. A change in
 * 38 CFR (VA) might affect HIPAA (Health) or FERPA (Education) claims.
 *
 * Patent: US 63/896,282 - Regulatory Compliance Verification
 *
 * Cron Schedule: Every 6 hours
 *
 * Evidence Chain Integration:
 *   - Each regulatory update is hashed and stored in R2 (evidence-chain)
 *   - Cross-domain impacts are tracked in D1 (audit trail)
 *   - Knowledge shards are embedded in Vectorize for collective learning
 */

// ============================================
// REGULATORY DOMAIN DEFINITIONS
// ============================================
const REGULATORY_DOMAINS = {
  va_disability: {
    name: '38 CFR - VA Disability',
    source: 'ecfr.gov',
    cfr_title: 38,
    parts: [3, 4, 17, 21],
    check_url: 'https://www.ecfr.gov/api/versioner/v1/titles/38',
    verticals: ['vetproof'],
    keywords: ['disability', 'compensation', 'service-connected', 'rating', 'TDIU', 'presumptive']
  },
  hipaa: {
    name: 'HIPAA - Health Privacy',
    source: 'ecfr.gov',
    cfr_title: 45,
    parts: [160, 162, 164],
    check_url: 'https://www.ecfr.gov/api/versioner/v1/titles/45',
    verticals: ['health', 'vetproof'],
    keywords: ['protected health information', 'PHI', 'privacy', 'security', 'breach notification']
  },
  faa_uas: {
    name: '14 CFR - FAA Aviation / UAS',
    source: 'ecfr.gov',
    cfr_title: 14,
    parts: [1, 21, 61, 91, 107, 135],
    check_url: 'https://www.ecfr.gov/api/versioner/v1/titles/14',
    verticals: ['aviation'],
    keywords: ['unmanned aircraft', 'remote pilot', 'airworthiness', 'advanced air mobility', 'eVTOL']
  },
  sox_financial: {
    name: 'SOX / Financial Regulation',
    source: 'sec.gov',
    cfr_title: 17,
    parts: [210, 229, 240, 249],
    check_url: 'https://www.ecfr.gov/api/versioner/v1/titles/17',
    verticals: ['finance'],
    keywords: ['internal controls', 'financial reporting', 'audit', 'material weakness', 'SOX']
  },
  ferpa_education: {
    name: 'FERPA - Education Privacy',
    source: 'ecfr.gov',
    cfr_title: 34,
    parts: [99],
    check_url: 'https://www.ecfr.gov/api/versioner/v1/titles/34',
    verticals: ['education'],
    keywords: ['student records', 'educational records', 'FERPA', 'directory information']
  },
  nist_ai: {
    name: 'NIST AI Risk Management Framework',
    source: 'nist.gov',
    cfr_title: null,
    parts: [],
    check_url: 'https://airc.nist.gov/AI_RMF_Interoperability',
    verticals: ['vetproof', 'legal', 'finance', 'health', 'education', 'aviation'],
    keywords: ['AI RMF', 'trustworthy AI', 'risk management', 'governance', 'bias', 'transparency']
  },
  eu_ai_act: {
    name: 'EU AI Act',
    source: 'eur-lex.europa.eu',
    cfr_title: null,
    parts: [],
    check_url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689',
    verticals: ['vetproof', 'legal', 'finance', 'health', 'education', 'aviation'],
    keywords: ['high-risk AI', 'prohibited AI', 'conformity assessment', 'CE marking', 'sandbox']
  },
  mn_mcdpa: {
    name: 'Minnesota Consumer Data Privacy Act',
    source: 'revisor.mn.gov',
    cfr_title: null,
    parts: [],
    check_url: 'https://www.revisor.mn.gov/laws/2025/0/Session+Law/Chapter/9/',
    verticals: ['vetproof', 'health', 'legal'],
    keywords: ['consumer data', 'privacy', 'consent', 'data broker', 'Minnesota', 'MCDPA']
  },
  pqc_nist: {
    name: 'NIST Post-Quantum Cryptography Standards',
    source: 'nist.gov',
    cfr_title: null,
    parts: [],
    check_url: 'https://csrc.nist.gov/projects/post-quantum-cryptography',
    verticals: ['vetproof', 'legal', 'finance', 'health', 'education', 'aviation'],
    keywords: ['Dilithium', 'Kyber', 'SPHINCS+', 'post-quantum', 'lattice-based', 'FIPS 203', 'FIPS 204']
  }
};


// ============================================
// CROSS-DOMAIN SYMBIOSIS MAP
// ============================================
// When regulation X changes, it may impact verticals Y and Z.
// This is the "deep moat" - understanding regulatory interplay.
const SYMBIOSIS_MAP = {
  // HIPAA changes affect both health AND vetproof (VA health records)
  'hipaa -> vetproof': {
    trigger: 'hipaa',
    impact: 'vetproof',
    reason: 'VA health records are subject to both HIPAA and 38 CFR privacy rules',
    severity: 'high'
  },
  'hipaa -> legal': {
    trigger: 'hipaa',
    impact: 'legal',
    reason: 'HIPAA breach litigation creates legal compliance obligations',
    severity: 'medium'
  },
  // FAA changes affect aviation AND finance (insurance/liability)
  'faa_uas -> finance': {
    trigger: 'faa_uas',
    impact: 'finance',
    reason: 'UAS regulation changes affect aviation insurance and liability requirements',
    severity: 'medium'
  },
  // NIST AI affects ALL verticals
  'nist_ai -> vetproof': { trigger: 'nist_ai', impact: 'vetproof', reason: 'AI RMF compliance for AI-assisted claims', severity: 'high' },
  'nist_ai -> legal': { trigger: 'nist_ai', impact: 'legal', reason: 'AI governance requirements for legal AI', severity: 'high' },
  'nist_ai -> finance': { trigger: 'nist_ai', impact: 'finance', reason: 'AI risk management for financial AI', severity: 'high' },
  'nist_ai -> health': { trigger: 'nist_ai', impact: 'health', reason: 'AI safety requirements for clinical AI', severity: 'critical' },
  'nist_ai -> aviation': { trigger: 'nist_ai', impact: 'aviation', reason: 'AI certification for aviation systems', severity: 'critical' },
  // EU AI Act affects all international-facing verticals
  'eu_ai_act -> finance': { trigger: 'eu_ai_act', impact: 'finance', reason: 'EU AI Act high-risk classification for financial AI', severity: 'high' },
  'eu_ai_act -> health': { trigger: 'eu_ai_act', impact: 'health', reason: 'EU AI Act prohibited/high-risk medical AI', severity: 'critical' },
  // PQC changes affect ALL verticals (cryptographic foundations)
  'pqc_nist -> vetproof': { trigger: 'pqc_nist', impact: 'vetproof', reason: 'Post-quantum signature migration for proof chains', severity: 'high' },
  'pqc_nist -> finance': { trigger: 'pqc_nist', impact: 'finance', reason: 'PQC migration timeline for financial signatures', severity: 'critical' },
  // MN privacy law affects local operations
  'mn_mcdpa -> health': { trigger: 'mn_mcdpa', impact: 'health', reason: 'MN consumer data rules for health data processors', severity: 'medium' },
  'mn_mcdpa -> vetproof': { trigger: 'mn_mcdpa', impact: 'vetproof', reason: 'MN data privacy for veteran claim processors', severity: 'medium' }
};


// ============================================
// HTTP Handler + Scheduled Trigger
// ============================================
export default {
  // Cron trigger - runs every 6 hours
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRegulationCheck(env));
  },

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
          service: 'aevion-regulation-tracker',
          version: '1.0.0',
          capabilities: [
            'scheduled-regulation-checks',
            'cross-domain-symbiosis',
            'regulatory-knowledge-shards',
            'ecfr-api-integration',
            'evidence-chain-hashing',
            'audit-trail'
          ],
          domains_tracked: Object.keys(REGULATORY_DOMAINS).length,
          symbiosis_rules: Object.keys(SYMBIOSIS_MAP).length,
          schedule: '0 */6 * * *'
        }, { headers });
      }

      // List all tracked regulations
      if (path === '/v1/regulations' && request.method === 'GET') {
        return Response.json({
          domains: Object.entries(REGULATORY_DOMAINS).map(([key, reg]) => ({
            key,
            name: reg.name,
            source: reg.source,
            cfr_title: reg.cfr_title,
            verticals_affected: reg.verticals,
            keywords: reg.keywords
          })),
          count: Object.keys(REGULATORY_DOMAINS).length
        }, { headers });
      }

      // Get cross-domain symbiosis map
      if (path === '/v1/regulations/symbiosis' && request.method === 'GET') {
        return Response.json({
          symbiosis_rules: Object.entries(SYMBIOSIS_MAP).map(([key, rule]) => ({
            key,
            ...rule
          })),
          count: Object.keys(SYMBIOSIS_MAP).length,
          description: 'Cross-domain regulatory interplay rules. When regulation X changes, these verticals are also impacted.'
        }, { headers });
      }

      // Get recent regulatory updates
      if (path === '/v1/regulations/updates' && request.method === 'GET') {
        const domain = url.searchParams.get('domain');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);

        const updates = JSON.parse(
          await env.VERIFICATION_CACHE.get('regulation:updates:latest') || '[]'
        );

        const filtered = domain
          ? updates.filter(u => u.domain === domain)
          : updates;

        return Response.json({
          updates: filtered.slice(0, limit),
          count: filtered.length,
          last_check: await env.VERIFICATION_CACHE.get('regulation:last_check') || 'never'
        }, { headers });
      }

      // Manual trigger for regulation check
      if (path === '/v1/regulations/check' && request.method === 'POST') {
        const apiKey = request.headers.get('X-API-Key') || request.headers.get('Authorization');
        if (!apiKey) {
          return Response.json({ error: 'Authorization required' }, { status: 401, headers });
        }

        // Run check in background
        const promise = runRegulationCheck(env);

        return Response.json({
          status: 'check_started',
          domains: Object.keys(REGULATORY_DOMAINS).length,
          message: 'Regulation check started in background'
        }, { status: 202, headers });
      }

      // Get impacts for a specific vertical
      if (path.startsWith('/v1/regulations/impacts/') && request.method === 'GET') {
        const vertical = path.split('/').pop();

        // Find all symbiosis rules that impact this vertical
        const impacts = Object.entries(SYMBIOSIS_MAP)
          .filter(([_, rule]) => rule.impact === vertical)
          .map(([key, rule]) => ({ key, ...rule }));

        // Find direct regulations for this vertical
        const directRegs = Object.entries(REGULATORY_DOMAINS)
          .filter(([_, reg]) => reg.verticals.includes(vertical))
          .map(([key, reg]) => ({ key, name: reg.name, source: reg.source }));

        return Response.json({
          vertical,
          direct_regulations: directRegs,
          cross_domain_impacts: impacts,
          total_exposure: directRegs.length + impacts.length
        }, { headers });
      }

      // 404
      return Response.json({
        error: 'Not found',
        available_endpoints: [
          'GET  /health',
          'GET  /v1/regulations',
          'GET  /v1/regulations/symbiosis',
          'GET  /v1/regulations/updates',
          'POST /v1/regulations/check',
          'GET  /v1/regulations/impacts/:vertical'
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


// ============================================
// Scheduled Regulation Check
// ============================================
async function runRegulationCheck(env) {
  const checkId = crypto.randomUUID();
  const startTime = Date.now();
  const updates = [];

  for (const [domainKey, reg] of Object.entries(REGULATORY_DOMAINS)) {
    try {
      // Check eCFR API for CFR-based regulations
      if (reg.cfr_title && reg.source === 'ecfr.gov') {
        const response = await fetch(reg.check_url, {
          headers: { 'Accept': 'application/json' }
        });

        if (response.ok) {
          const data = await response.json();

          // Extract version/amendment info
          const lastAmended = data.last_amended_on || data.latest_issue_date || null;
          const cachedDate = await env.VERIFICATION_CACHE.get(`regulation:version:${domainKey}`);

          if (lastAmended && lastAmended !== cachedDate) {
            // Regulation has been updated
            const update = {
              id: crypto.randomUUID(),
              domain: domainKey,
              name: reg.name,
              cfr_title: reg.cfr_title,
              previous_date: cachedDate,
              new_date: lastAmended,
              verticals_affected: reg.verticals,
              detected_at: new Date().toISOString(),
              check_id: checkId
            };

            updates.push(update);

            // Update cached version
            await env.VERIFICATION_CACHE.put(
              `regulation:version:${domainKey}`,
              lastAmended,
              { expirationTtl: 86400 * 365 }
            );

            // Check cross-domain impacts
            const impacts = Object.entries(SYMBIOSIS_MAP)
              .filter(([_, rule]) => rule.trigger === domainKey);

            for (const [impactKey, impact] of impacts) {
              updates.push({
                id: crypto.randomUUID(),
                domain: domainKey,
                name: reg.name,
                type: 'cross_domain_impact',
                impacted_vertical: impact.impact,
                reason: impact.reason,
                severity: impact.severity,
                detected_at: new Date().toISOString(),
                check_id: checkId
              });
            }
          }
        }
      }

      // For non-CFR sources, do an AI-assisted check
      if (!reg.cfr_title) {
        const ai = env.AI;
        const cachedSummary = await env.VERIFICATION_CACHE.get(`regulation:summary:${domainKey}`);

        const result = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
          prompt: `You are a regulatory analyst. Based on your knowledge, provide a brief JSON status update for ${reg.name}.

Focus on: ${reg.keywords.join(', ')}

Respond with JSON only:
{
  "status": "current|pending_changes|recently_updated",
  "key_developments": ["list max 3 items"],
  "effective_dates": ["any upcoming dates"],
  "impact_summary": "one sentence"
}`,
          max_tokens: 256,
          temperature: 0.1
        });

        let parsed;
        try {
          const jsonMatch = result.response.match(/\{[\s\S]*\}/);
          parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
        } catch {
          parsed = null;
        }

        if (parsed && parsed.status !== 'current') {
          updates.push({
            id: crypto.randomUUID(),
            domain: domainKey,
            name: reg.name,
            type: 'ai_detected_change',
            status: parsed.status,
            developments: parsed.key_developments,
            impact: parsed.impact_summary,
            verticals_affected: reg.verticals,
            detected_at: new Date().toISOString(),
            check_id: checkId
          });
        }

        // Cache the summary
        if (parsed) {
          await env.VERIFICATION_CACHE.put(
            `regulation:summary:${domainKey}`,
            JSON.stringify(parsed),
            { expirationTtl: 86400 }
          );
        }
      }
    } catch (e) {
      // Individual domain failure is non-fatal
      updates.push({
        id: crypto.randomUUID(),
        domain: domainKey,
        type: 'check_error',
        error: e.message,
        detected_at: new Date().toISOString(),
        check_id: checkId
      });
    }
  }

  // Store updates
  const existingUpdates = JSON.parse(
    await env.VERIFICATION_CACHE.get('regulation:updates:latest') || '[]'
  );
  const allUpdates = [...updates, ...existingUpdates].slice(0, 500);
  await env.VERIFICATION_CACHE.put(
    'regulation:updates:latest',
    JSON.stringify(allUpdates),
    { expirationTtl: 86400 * 30 }
  );

  // Record check timestamp
  await env.VERIFICATION_CACHE.put(
    'regulation:last_check',
    new Date().toISOString(),
    { expirationTtl: 86400 * 365 }
  );

  // Embed regulatory knowledge shards in Vectorize
  for (const update of updates.filter(u => u.type !== 'check_error')) {
    try {
      const ai = env.AI;
      const text = `${update.name} ${update.type || 'update'}: ${JSON.stringify(update.developments || update.reason || update.impact || '')}`;
      const embedding = await ai.run('@cf/baai/bge-base-en-v1.5', { text });

      if (embedding.data && embedding.data[0]) {
        await env.VECTORIZE.upsert([{
          id: `reg-${update.domain}-${update.id.slice(0, 8)}`,
          values: embedding.data[0],
          metadata: {
            domain: update.domain,
            pattern_type: 'regulation',
            confidence: 0.9,
            claim_type: update.type || 'regulatory_update',
            risk_level: update.severity || 'medium',
            status: 'active',
            created_at: update.detected_at
          }
        }]);
      }
    } catch (e) {
      // Vectorize failure non-fatal
    }
  }

  // Audit trail
  try {
    await env.AUDIT_DB.prepare(
      `INSERT INTO audit_events (id, event_type, claim_id, data, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      checkId,
      'regulation_check',
      checkId,
      JSON.stringify({
        domains_checked: Object.keys(REGULATORY_DOMAINS).length,
        updates_found: updates.length,
        errors: updates.filter(u => u.type === 'check_error').length,
        processing_time_ms: Date.now() - startTime
      }),
      new Date().toISOString()
    ).run();
  } catch (e) {
    // D1 failure non-fatal
  }

  // Hash and store evidence in R2
  try {
    const evidenceData = {
      check_id: checkId,
      timestamp: new Date().toISOString(),
      domains_checked: Object.keys(REGULATORY_DOMAINS).length,
      updates: updates,
      processing_time_ms: Date.now() - startTime
    };

    const encoder = new TextEncoder();
    const data = encoder.encode(JSON.stringify(evidenceData));
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    evidenceData.evidence_hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    await env.PROOF_STORAGE.put(
      `regulations/${new Date().toISOString().slice(0, 10)}/${checkId}.json`,
      JSON.stringify(evidenceData, null, 2),
      {
        customMetadata: {
          type: 'regulation_check',
          updates_count: String(updates.length),
          check_date: new Date().toISOString()
        }
      }
    );
  } catch (e) {
    // R2 failure non-fatal
  }

  return { checkId, updates: updates.length, processing_time_ms: Date.now() - startTime };
}
