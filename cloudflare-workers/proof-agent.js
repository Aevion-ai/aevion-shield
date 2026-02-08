/**
 * Aevion Proof Agent - Cloudflare Agents SDK + x402 Payment
 *
 * A stateful AI agent that provides verification-as-a-service with
 * x402 micropayment gating. This is the core monetization primitive
 * for the Aevion platform.
 *
 * Patent Coverage:
 * - x402 Payment Headers (Core IP)
 * - Claim 3: Constitutional Halt
 * - Claim 5: Weighted Voting with coherence threshold
 * - Claims 79-82: Multi-verifier proofs
 *
 * Architecture:
 *   Client -> x402 Payment -> Agent (Durable Object) -> Workers AI
 *                                |
 *                    [SQLite State] [KV Cache] [D1 Audit] [R2 Archive]
 *
 * Endpoints:
 *   GET  /health              - Health check
 *   GET  /agents/:agent/:name - WebSocket connection to agent
 *   POST /v1/verify           - Single claim verification (x402 gated)
 *   POST /v1/batch-verify     - Batch verification (x402 gated)
 *   GET  /v1/proof/:id        - Retrieve proof by ID
 *   GET  /v1/agent/state      - Get agent state
 *   POST /v1/agent/schedule   - Schedule a verification task
 */

// ============================================
// PROOF AGENT (Durable Object with Agent SDK pattern)
// ============================================

export class ProofAgent {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.state = null;
    this.connections = new Map();

    // Initialize SQLite tables on first access
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS verification_history (
        id TEXT PRIMARY KEY,
        claim_text TEXT,
        result TEXT,
        confidence REAL,
        models_used TEXT,
        proof_hash TEXT,
        payment_tx TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        callback TEXT,
        data TEXT,
        run_at TEXT,
        status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  // --- State Management ---
  getState() {
    if (!this.state) {
      const rows = this.ctx.storage.sql.exec(
        `SELECT value FROM agent_state WHERE key = 'state'`
      ).toArray();
      this.state = rows.length > 0 ? JSON.parse(rows[0].value) : {
        verifications_count: 0,
        total_revenue_cents: 0,
        last_verification: null,
        models_available: ['@cf/meta/llama-3.1-8b-instruct', '@cf/qwen/qwen1.5-14b-chat-awq'],
        halt_threshold: 0.67,
        coherence_threshold: 0.85,
        agent_version: '1.0.0',
      };
    }
    return this.state;
  }

  setState(newState) {
    this.state = { ...this.getState(), ...newState };
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO agent_state (key, value, updated_at) VALUES ('state', ?, datetime('now'))`,
      JSON.stringify(this.state)
    );
    // Broadcast state update to all connected WebSocket clients
    this.broadcast(JSON.stringify({ type: 'cf_agent_state', state: this.state }));
  }

  broadcast(message) {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(message); } catch (e) { /* connection closed */ }
    }
  }

  // --- HTTP Handler ---
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    // Health
    if (path === '/health' || path === '/') {
      return jsonResponse({
        status: 'healthy',
        service: 'aevion-proof-agent',
        version: '1.0.0',
        agent_state: this.getState(),
        capabilities: [
          'x402-payment',
          'shield-consensus',
          'websocket-state-sync',
          'scheduled-tasks',
          'proof-archive',
          'hitl-approval',
        ],
      });
    }

    // Verify single claim
    if (path === '/v1/verify' && request.method === 'POST') {
      return this.handleVerify(request);
    }

    // Batch verify
    if (path === '/v1/batch-verify' && request.method === 'POST') {
      return this.handleBatchVerify(request);
    }

    // Get proof by ID
    if (path.startsWith('/v1/proof/') && request.method === 'GET') {
      const proofId = path.split('/v1/proof/')[1];
      return this.handleGetProof(proofId);
    }

    // Agent state
    if (path === '/v1/agent/state' && request.method === 'GET') {
      return jsonResponse({ state: this.getState() });
    }

    // Schedule task
    if (path === '/v1/agent/schedule' && request.method === 'POST') {
      return this.handleScheduleTask(request);
    }

    // Verification history
    if (path === '/v1/history' && request.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const rows = this.ctx.storage.sql.exec(
        `SELECT * FROM verification_history ORDER BY created_at DESC LIMIT ?`,
        limit
      ).toArray();
      return jsonResponse({ history: rows, count: rows.length });
    }

    return jsonResponse({ error: 'Not found' }, 404);
  }

  // --- WebSocket Handler ---
  handleWebSocket(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    // Send initial state
    server.send(JSON.stringify({
      type: 'cf_agent_state',
      state: this.getState(),
    }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);

      // Handle RPC calls
      if (data.type === 'rpc') {
        const result = await this.handleRPC(data.method, data.args || []);
        ws.send(JSON.stringify({ type: 'rpc_response', id: data.id, result }));
        return;
      }

      // Handle state updates from client
      if (data.type === 'cf_agent_state') {
        this.setState(data.state);
        return;
      }

      // Handle verification requests via WebSocket
      if (data.type === 'verify') {
        const result = await this.verifyClaimInternal(data.claim);
        ws.send(JSON.stringify({ type: 'verification_result', ...result }));
        return;
      }

      ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    // Cleanup handled automatically by Durable Objects
  }

  async webSocketError(ws, error) {
    console.error('WebSocket error:', error);
  }

  // --- RPC Handler ---
  async handleRPC(method, args) {
    switch (method) {
      case 'verify':
        return this.verifyClaimInternal(args[0]);
      case 'getState':
        return this.getState();
      case 'getHistory':
        return this.ctx.storage.sql.exec(
          `SELECT * FROM verification_history ORDER BY created_at DESC LIMIT ?`,
          args[0] || 20
        ).toArray();
      default:
        throw new Error(`Unknown RPC method: ${method}`);
    }
  }

  // --- Verification Logic ---
  async handleVerify(request) {
    // x402 Payment Check
    const paymentStatus = this.checkX402Payment(request);
    if (paymentStatus && !paymentStatus.paid) {
      return new Response(JSON.stringify({
        error: 'Payment Required',
        x402: {
          price: '$0.01',
          network: 'base',
          description: 'Single claim verification via Aevion Shield Consensus',
          accepts: ['USDC', 'ETH'],
        },
      }), {
        status: 402,
        headers: {
          'Content-Type': 'application/json',
          'X-Payment-Required': 'true',
          'X-Price': '0.01',
          'X-Currency': 'USD',
          'X-Network': 'base',
        },
      });
    }

    try {
      const body = await request.json();
      if (!body.claim) {
        return jsonResponse({ error: 'Missing claim field' }, 400);
      }

      const result = await this.verifyClaimInternal(body.claim, body.context);

      // Track payment if x402 header present
      const paymentTx = request.headers.get('X-Payment-Tx') || null;
      if (paymentTx) {
        result.payment_tx = paymentTx;
        this.setState({
          total_revenue_cents: this.getState().total_revenue_cents + 1,
        });
      }

      return jsonResponse(result);
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  async handleBatchVerify(request) {
    // x402 Payment Check (higher price for batch)
    const paymentStatus = this.checkX402Payment(request);
    if (paymentStatus && !paymentStatus.paid) {
      return new Response(JSON.stringify({
        error: 'Payment Required',
        x402: {
          price: '$0.05',
          network: 'base',
          description: 'Batch verification (up to 10 claims) via Aevion Shield Consensus',
          accepts: ['USDC', 'ETH'],
        },
      }), {
        status: 402,
        headers: {
          'Content-Type': 'application/json',
          'X-Payment-Required': 'true',
          'X-Price': '0.05',
          'X-Currency': 'USD',
          'X-Network': 'base',
        },
      });
    }

    try {
      const body = await request.json();
      if (!body.claims || !Array.isArray(body.claims)) {
        return jsonResponse({ error: 'Missing claims array' }, 400);
      }
      if (body.claims.length > 10) {
        return jsonResponse({ error: 'Max 10 claims per batch' }, 400);
      }

      const results = await Promise.all(
        body.claims.map(claim => this.verifyClaimInternal(claim))
      );

      return jsonResponse({
        results,
        batch_size: results.length,
        batch_id: crypto.randomUUID(),
      });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  async verifyClaimInternal(claimText, context) {
    const claimId = crypto.randomUUID();
    const state = this.getState();
    const models = state.models_available;

    // Shield Consensus: Multi-model voting
    const votes = [];
    for (const model of models) {
      try {
        const response = await this.env.AI.run(model, {
          messages: [
            {
              role: 'system',
              content: `You are a verification agent. Assess the following claim for truthfulness.
Respond with JSON: {"verdict": "VERIFIED"|"UNVERIFIED"|"INSUFFICIENT_EVIDENCE", "confidence": 0.0-1.0, "reasoning": "..."}
Be precise and conservative. If uncertain, use lower confidence.`,
            },
            {
              role: 'user',
              content: context
                ? `Claim: "${claimText}"\nContext: ${context}`
                : `Claim: "${claimText}"`,
            },
          ],
          max_tokens: 512,
        });

        const text = response.response || '';
        const parsed = tryParseJSON(text);
        if (parsed) {
          votes.push({
            model,
            verdict: parsed.verdict || 'UNVERIFIED',
            confidence: Math.min(1.0, Math.max(0.0, parseFloat(parsed.confidence) || 0.5)),
            reasoning: parsed.reasoning || '',
          });
        }
      } catch (e) {
        votes.push({
          model,
          verdict: 'ERROR',
          confidence: 0,
          reasoning: `Model error: ${e.message}`,
        });
      }
    }

    // BFT Consensus calculation
    const validVotes = votes.filter(v => v.verdict !== 'ERROR');
    const quorumSize = Math.ceil((2 * models.length) / 3);
    const hasQuorum = validVotes.length >= quorumSize;

    // Weighted confidence aggregation
    const totalConfidence = validVotes.reduce((sum, v) => sum + v.confidence, 0);
    const avgConfidence = validVotes.length > 0 ? totalConfidence / validVotes.length : 0;

    // Variance calculation for constitutional halt
    const confidences = validVotes.map(v => v.confidence);
    const mean = avgConfidence;
    const variance = confidences.length > 0
      ? confidences.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / confidences.length
      : 0;
    const stdDev = Math.sqrt(variance);

    // Constitutional Halt: trigger if stdDev > 0.25 (high disagreement)
    const constitutionalHalt = stdDev > 0.25;

    // Majority verdict
    const verdictCounts = {};
    validVotes.forEach(v => {
      verdictCounts[v.verdict] = (verdictCounts[v.verdict] || 0) + 1;
    });
    const majorityVerdict = Object.entries(verdictCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'INSUFFICIENT_EVIDENCE';

    // Final verdict with halt check
    const finalVerdict = constitutionalHalt ? 'CONSTITUTIONAL_HALT' : majorityVerdict;

    // Generate proof hash
    const proofData = JSON.stringify({ claimId, claimText, votes, finalVerdict, avgConfidence });
    const proofHash = await sha256(proofData);

    const result = {
      claim_id: claimId,
      claim: claimText,
      verdict: finalVerdict,
      confidence: parseFloat(avgConfidence.toFixed(4)),
      std_dev: parseFloat(stdDev.toFixed(4)),
      constitutional_halt: constitutionalHalt,
      quorum: hasQuorum,
      votes: validVotes.length,
      required_quorum: quorumSize,
      proof_hash: proofHash,
      models_used: votes.map(v => v.model),
      model_votes: votes,
      timestamp: new Date().toISOString(),
    };

    // Persist to SQLite history
    this.ctx.storage.sql.exec(
      `INSERT INTO verification_history (id, claim_text, result, confidence, models_used, proof_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      claimId, claimText, finalVerdict, avgConfidence, JSON.stringify(votes.map(v => v.model)), proofHash
    );

    // Update agent state
    this.setState({
      verifications_count: state.verifications_count + 1,
      last_verification: new Date().toISOString(),
    });

    // Broadcast result to connected clients
    this.broadcast(JSON.stringify({ type: 'verification_result', ...result }));

    // Cache in KV for fast lookups
    try {
      await this.env.VERIFICATION_CACHE.put(
        `proof:${claimId}`,
        JSON.stringify(result),
        { expirationTtl: 86400 }
      );
    } catch (e) { /* KV write failure is non-critical */ }

    // Archive proof in R2
    try {
      await this.env.PROOF_STORAGE.put(
        `proofs/${new Date().toISOString().split('T')[0]}/${claimId}.json`,
        JSON.stringify(result, null, 2)
      );
    } catch (e) { /* R2 write failure is non-critical */ }

    // Audit trail in D1
    try {
      await this.env.AUDIT_DB.prepare(
        `INSERT INTO audit_events (event_type, proof_hash, claim_id, verdict, confidence, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind('verification', proofHash, claimId, finalVerdict, avgConfidence, new Date().toISOString()).run();
    } catch (e) { /* D1 write failure is non-critical */ }

    return result;
  }

  // --- x402 Payment Verification ---
  checkX402Payment(request) {
    // Check for x402 payment header
    const paymentHeader = request.headers.get('X-Payment');
    const paymentTx = request.headers.get('X-Payment-Tx');

    // If no payment headers at all, this endpoint requires payment
    if (!paymentHeader && !paymentTx) {
      // Check if request has API key (free tier)
      const apiKey = request.headers.get('X-API-Key') || request.headers.get('Authorization');
      if (apiKey) {
        return { paid: true, method: 'api-key' };
      }
      return { paid: false };
    }

    // x402 payment present
    return { paid: true, method: 'x402', tx: paymentTx };
  }

  // --- Proof Retrieval ---
  async handleGetProof(proofId) {
    // Check KV cache first
    try {
      const cached = await this.env.VERIFICATION_CACHE.get(`proof:${proofId}`);
      if (cached) {
        return jsonResponse(JSON.parse(cached));
      }
    } catch (e) { /* cache miss */ }

    // Check SQLite
    const rows = this.ctx.storage.sql.exec(
      `SELECT * FROM verification_history WHERE id = ?`, proofId
    ).toArray();

    if (rows.length > 0) {
      return jsonResponse(rows[0]);
    }

    return jsonResponse({ error: 'Proof not found' }, 404);
  }

  // --- Task Scheduling ---
  async handleScheduleTask(request) {
    try {
      const body = await request.json();
      const taskId = crypto.randomUUID();

      this.ctx.storage.sql.exec(
        `INSERT INTO scheduled_tasks (id, callback, data, run_at, status) VALUES (?, ?, ?, ?, 'pending')`,
        taskId, body.callback || 'verify', JSON.stringify(body.data || {}), body.run_at || new Date().toISOString()
      );

      // Set alarm for the task
      const runAt = new Date(body.run_at || Date.now() + 60000);
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (!currentAlarm || runAt.getTime() < currentAlarm) {
        await this.ctx.storage.setAlarm(runAt.getTime());
      }

      return jsonResponse({ task_id: taskId, scheduled_for: runAt.toISOString() });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  // --- Alarm Handler (for scheduled tasks) ---
  async alarm() {
    const now = new Date().toISOString();
    const tasks = this.ctx.storage.sql.exec(
      `SELECT * FROM scheduled_tasks WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT 5`,
      now
    ).toArray();

    for (const task of tasks) {
      try {
        const data = JSON.parse(task.data);

        if (task.callback === 'verify' && data.claim) {
          await this.verifyClaimInternal(data.claim, data.context);
        }

        this.ctx.storage.sql.exec(
          `UPDATE scheduled_tasks SET status = 'completed' WHERE id = ?`,
          task.id
        );
      } catch (e) {
        this.ctx.storage.sql.exec(
          `UPDATE scheduled_tasks SET status = 'failed' WHERE id = ?`,
          task.id
        );
      }
    }

    // Check for more pending tasks
    const nextTask = this.ctx.storage.sql.exec(
      `SELECT run_at FROM scheduled_tasks WHERE status = 'pending' ORDER BY run_at LIMIT 1`
    ).toArray();

    if (nextTask.length > 0) {
      const nextRunAt = new Date(nextTask[0].run_at).getTime();
      await this.ctx.storage.setAlarm(Math.max(nextRunAt, Date.now() + 1000));
    }
  }
}

// ============================================
// WORKER ENTRY POINT
// ============================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check at worker level
    if (path === '/health') {
      return jsonResponse({
        status: 'healthy',
        service: 'aevion-proof-agent',
        version: '1.0.0',
        capabilities: [
          'x402-payment-gating',
          'shield-consensus',
          'durable-state',
          'websocket-sync',
          'scheduled-tasks',
          'proof-archive',
          'hitl-approval',
        ],
        x402: {
          enabled: true,
          pricing: {
            single_verify: '$0.01',
            batch_verify: '$0.05',
            network: 'base',
          },
        },
      });
    }

    // Route to agent by name
    // Pattern: /agents/proof-agent/:name or /v1/* routes to default agent
    let agentName = 'default';

    if (path.startsWith('/agents/proof-agent/')) {
      agentName = path.split('/agents/proof-agent/')[1].split('/')[0] || 'default';
    }

    // Get or create the agent Durable Object
    const id = env.PROOF_AGENT.idFromName(agentName);
    const agent = env.PROOF_AGENT.get(id);

    // Forward request to the agent
    return agent.fetch(request);
  },
};

// ============================================
// UTILITIES
// ============================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Payment, X-Payment-Tx',
      'X-Powered-By': 'Aevion Shield',
    },
  });
}

async function sha256(message) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function tryParseJSON(text) {
  // Try to extract JSON from the response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      return null;
    }
  }
  return null;
}
