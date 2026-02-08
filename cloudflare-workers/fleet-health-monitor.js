/**
 * Aevion Fleet Health Monitor
 *
 * CEO OPERATIONS LAYER: Automated health monitoring for the entire 9-worker fleet.
 * Runs every 15 minutes via cron, pings every worker health endpoint, stores results
 * in D1, and triggers alerts via notification-hub when anything degrades.
 *
 * Why this exists: Solo founder cannot manually check 9 workers + Pi Sheriff.
 * This worker does it automatically and only bothers you when something breaks.
 *
 * Patent: US 63/896,282 - Infrastructure Verification
 * NIST AI RMF: GV-1.1 (Governance), MP-4.1 (Monitoring)
 */

// ============================================
// FLEET TOPOLOGY - All workers to monitor
// ============================================
const FLEET = [
  {
    name: 'edge-sheriff',
    url: 'https://verify.aevion.ai/health',
    critical: true,
    description: 'Ed25519 cryptographic verification at edge'
  },
  {
    name: 'ai-sheriff',
    url: 'https://ai.aevion.ai/health',
    critical: true,
    description: 'Workers AI inference layer'
  },
  {
    name: 'vetproof-consensus',
    url: 'https://consensus.aevion.ai/health',
    critical: true,
    description: 'BFT consensus coordinator'
  },
  {
    name: 'vetproof-workflow',
    url: 'https://workflow.aevion.ai/health',
    critical: true,
    description: '6-step durable verification pipeline'
  },
  {
    name: 'proof-agent',
    url: 'https://agent.aevion.ai/health',
    critical: true,
    description: 'x402 payment-gated agent'
  },
  {
    name: 'vetproof-hitl',
    url: 'https://hitl.aevion.ai/health',
    critical: true,
    description: 'Human-in-the-loop approval workflow'
  },
  {
    name: 'sentient-collective',
    url: 'https://collective.aevion.ai/health',
    critical: true,
    description: 'Multi-vertical collective intelligence'
  },
  {
    name: 'regulation-tracker',
    url: 'https://regs.aevion.ai/health',
    critical: false,
    description: 'Scheduled regulatory database (cron)'
  },
  {
    name: 'pi-sheriff',
    url: 'http://192.168.68.52:8402/health',
    critical: false,
    description: 'Raspberry Pi hardware trust anchor',
    isExternal: true
  }
];

// ============================================
// HEALTH CHECK THRESHOLDS
// ============================================
const THRESHOLDS = {
  responseTimeWarning: 2000,   // 2s = warning
  responseTimeCritical: 5000,  // 5s = critical
  consecutiveFailures: 3,      // 3 fails = alert
  uptimeTarget: 0.999,         // 99.9% target
  checkInterval: '*/15 * * * *' // every 15 min
};

// ============================================
// STATUS CALCULATION
// ============================================
function calculateOverallStatus(results) {
  const criticalDown = results.filter(r => r.critical && r.status === 'down').length;
  const anyDown = results.filter(r => r.status === 'down').length;
  const degraded = results.filter(r => r.status === 'degraded').length;

  if (criticalDown > 0) return 'critical';
  if (anyDown > 0 || degraded > 2) return 'degraded';
  if (degraded > 0) return 'warning';
  return 'healthy';
}

function calculateUptime(checks) {
  if (!checks || checks.length === 0) return 1.0;
  const healthy = checks.filter(c => c.status === 'healthy').length;
  return healthy / checks.length;
}

// ============================================
// SINGLE WORKER HEALTH CHECK
// ============================================
async function checkWorkerHealth(worker) {
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), THRESHOLDS.responseTimeCritical);

    const response = await fetch(worker.url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'Aevion-Fleet-Monitor/1.0' }
    });

    clearTimeout(timeout);
    const responseTime = Date.now() - start;
    const ok = response.ok;

    let body = null;
    try {
      body = await response.json();
    } catch (e) {
      // Some health endpoints return plain text
    }

    let status = 'healthy';
    if (!ok) status = 'down';
    else if (responseTime > THRESHOLDS.responseTimeCritical) status = 'degraded';
    else if (responseTime > THRESHOLDS.responseTimeWarning) status = 'degraded';

    return {
      name: worker.name,
      critical: worker.critical,
      status,
      responseTime,
      httpStatus: response.status,
      details: body,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      name: worker.name,
      critical: worker.critical,
      status: 'down',
      responseTime: Date.now() - start,
      httpStatus: 0,
      error: error.message,
      checkedAt: new Date().toISOString()
    };
  }
}

// ============================================
// FLEET-WIDE HEALTH CHECK
// ============================================
async function runFleetHealthCheck(env) {
  // Check all workers in parallel
  const results = await Promise.all(
    FLEET.filter(w => !w.isExternal).map(w => checkWorkerHealth(w))
  );

  // Pi Sheriff is external/LAN - skip in production edge checks
  // but note its expected status
  results.push({
    name: 'pi-sheriff',
    critical: false,
    status: 'external',
    responseTime: 0,
    httpStatus: 0,
    details: { note: 'LAN-only, not reachable from edge. Check via Cloudflare Tunnel when configured.' },
    checkedAt: new Date().toISOString()
  });

  const overallStatus = calculateOverallStatus(results);
  const timestamp = new Date().toISOString();
  const checkId = crypto.randomUUID();

  // Store in D1
  try {
    await env.AUDIT_DB.prepare(
      `INSERT INTO audit_events (id, event_type, claim_id, data, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      checkId,
      'fleet_health_check',
      overallStatus,
      JSON.stringify({ results, thresholds: THRESHOLDS }),
      timestamp
    ).run();
  } catch (e) {
    // D1 failure shouldn't block health check
    console.error('D1 audit insert failed:', e.message);
  }

  // Store latest status in KV for fast dashboard reads
  await env.VERIFICATION_CACHE.put('fleet:latest_health', JSON.stringify({
    checkId,
    overallStatus,
    results,
    timestamp
  }), { expirationTtl: 3600 }); // 1 hour TTL

  // Store per-worker status for historical tracking
  for (const result of results) {
    const key = `fleet:health:${result.name}:latest`;
    await env.VERIFICATION_CACHE.put(key, JSON.stringify(result), { expirationTtl: 86400 });
  }

  // Check for consecutive failures and trigger alerts
  const alerts = [];
  for (const result of results) {
    if (result.status === 'down' || (result.status === 'degraded' && result.critical)) {
      const failKey = `fleet:failures:${result.name}`;
      const prevFails = parseInt(await env.VERIFICATION_CACHE.get(failKey) || '0');
      const newFails = prevFails + 1;
      await env.VERIFICATION_CACHE.put(failKey, String(newFails), { expirationTtl: 3600 });

      if (newFails >= THRESHOLDS.consecutiveFailures) {
        alerts.push({
          severity: result.critical ? 'critical' : 'warning',
          worker: result.name,
          status: result.status,
          consecutiveFailures: newFails,
          description: result.description || result.name,
          error: result.error
        });
      }
    } else {
      // Reset failure counter on success
      await env.VERIFICATION_CACHE.delete(`fleet:failures:${result.name}`);
    }
  }

  // Send alerts if any
  if (alerts.length > 0) {
    try {
      // Store alert for notification-hub to pick up
      await env.VERIFICATION_CACHE.put('fleet:pending_alerts', JSON.stringify({
        alerts,
        timestamp,
        checkId
      }), { expirationTtl: 3600 });
    } catch (e) {
      console.error('Failed to store alerts:', e.message);
    }
  }

  return {
    checkId,
    overallStatus,
    workerCount: results.length,
    healthy: results.filter(r => r.status === 'healthy').length,
    degraded: results.filter(r => r.status === 'degraded').length,
    down: results.filter(r => r.status === 'down').length,
    external: results.filter(r => r.status === 'external').length,
    alerts: alerts.length,
    results,
    timestamp
  };
}

// ============================================
// UPTIME REPORT (last 24h / 7d / 30d)
// ============================================
async function getUptimeReport(env, period = '24h') {
  const periodHours = period === '7d' ? 168 : period === '30d' ? 720 : 24;
  const since = new Date(Date.now() - periodHours * 60 * 60 * 1000).toISOString();

  try {
    const checks = await env.AUDIT_DB.prepare(
      `SELECT id, claim_id as status, data, created_at
       FROM audit_events
       WHERE event_type = 'fleet_health_check' AND created_at > ?
       ORDER BY created_at DESC
       LIMIT 1000`
    ).bind(since).all();

    const totalChecks = checks.results.length;
    const healthyChecks = checks.results.filter(c => c.status === 'healthy').length;
    const uptime = totalChecks > 0 ? (healthyChecks / totalChecks * 100).toFixed(3) : '100.000';

    // Per-worker breakdown
    const workerStats = {};
    for (const check of checks.results) {
      try {
        const data = JSON.parse(check.data);
        for (const result of data.results) {
          if (!workerStats[result.name]) {
            workerStats[result.name] = { total: 0, healthy: 0, avgResponseTime: 0 };
          }
          workerStats[result.name].total++;
          if (result.status === 'healthy') workerStats[result.name].healthy++;
          workerStats[result.name].avgResponseTime += result.responseTime || 0;
        }
      } catch (e) {
        // Skip malformed entries
      }
    }

    // Calculate averages
    for (const name of Object.keys(workerStats)) {
      const stats = workerStats[name];
      stats.uptime = stats.total > 0 ? (stats.healthy / stats.total * 100).toFixed(2) + '%' : 'N/A';
      stats.avgResponseTime = stats.total > 0 ? Math.round(stats.avgResponseTime / stats.total) + 'ms' : 'N/A';
    }

    return {
      period,
      totalChecks,
      overallUptime: uptime + '%',
      target: (THRESHOLDS.uptimeTarget * 100).toFixed(1) + '%',
      meetingTarget: parseFloat(uptime) >= THRESHOLDS.uptimeTarget * 100,
      workers: workerStats,
      since
    };
  } catch (e) {
    return { error: e.message, period };
  }
}

// ============================================
// COST ESTIMATOR
// ============================================
async function estimateMonthlyCost(env) {
  // Pull usage from KV counters if available
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const costs = {
    workers: { requests: 0, cost: 0, freeLimit: 100000, perMillion: 0.30 },
    kv: { reads: 0, writes: 0, cost: 0, freeReads: 100000, perMillionReads: 0.50 },
    d1: { rows: 0, cost: 0, freeRows: 5000000, perMillionRows: 0.75 },
    r2: { stored: 0, cost: 0, freeGB: 10, perGB: 0.015 },
    ai: { neurons: 0, cost: 0, freeNeurons: 10000, perThousand: 0.011 },
    vectorize: { queries: 0, cost: 0, freeQueries: 30000000, perMillion: 0.01 },
    total: 0
  };

  // Try to read counters
  try {
    const usage = await env.VERIFICATION_CACHE.get(`usage:${month}`);
    if (usage) {
      const data = JSON.parse(usage);
      // Calculate costs based on actual usage
      Object.assign(costs, data);
    }
  } catch (e) {
    // Use defaults
  }

  costs.total = Object.values(costs)
    .filter(v => typeof v === 'object' && v.cost !== undefined)
    .reduce((sum, v) => sum + v.cost, 0);

  return {
    month,
    estimated: '$' + costs.total.toFixed(2),
    breakdown: costs,
    tier: costs.total === 0 ? 'Free Tier' : costs.total < 5 ? 'Hobby ($5/mo Workers Paid)' : 'Scale',
    note: 'Cloudflare $250K FounderPass credit covers all usage'
  };
}

// ============================================
// HTTP HANDLER
// ============================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const json = (data, status = 200) => new Response(
      JSON.stringify(data, null, 2),
      { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

    try {
      // Health endpoint (for self-monitoring - yes, the monitor monitors itself)
      if (path === '/health') {
        return json({
          service: 'aevion-fleet-health-monitor',
          status: 'operational',
          version: '1.0.0',
          fleet_size: FLEET.length,
          check_interval: THRESHOLDS.checkInterval,
          patent: 'US 63/896,282'
        });
      }

      // CEO Dashboard - single endpoint, full picture
      if (path === '/v1/dashboard') {
        const [health, uptime24h, uptime7d, costs] = await Promise.all([
          runFleetHealthCheck(env),
          getUptimeReport(env, '24h'),
          getUptimeReport(env, '7d'),
          estimateMonthlyCost(env)
        ]);

        return json({
          status: health.overallStatus,
          summary: {
            workers_total: health.workerCount,
            workers_healthy: health.healthy,
            workers_degraded: health.degraded,
            workers_down: health.down,
            active_alerts: health.alerts
          },
          uptime: {
            '24h': uptime24h.overallUptime,
            '7d': uptime7d.overallUptime,
            target: THRESHOLDS.uptimeTarget * 100 + '%'
          },
          costs: {
            estimated: costs.estimated,
            tier: costs.tier
          },
          workers: health.results.map(r => ({
            name: r.name,
            status: r.status,
            responseTime: r.responseTime + 'ms',
            critical: r.critical
          })),
          timestamp: health.timestamp,
          patent: 'US 63/896,282'
        });
      }

      // Run health check manually
      if (path === '/v1/fleet/check') {
        const result = await runFleetHealthCheck(env);
        return json(result);
      }

      // Uptime report
      if (path === '/v1/fleet/uptime') {
        const period = url.searchParams.get('period') || '24h';
        const report = await getUptimeReport(env, period);
        return json(report);
      }

      // Cost estimate
      if (path === '/v1/fleet/costs') {
        const costs = await estimateMonthlyCost(env);
        return json(costs);
      }

      // Get latest cached status (fast, no re-check)
      if (path === '/v1/fleet/status') {
        const cached = await env.VERIFICATION_CACHE.get('fleet:latest_health');
        if (cached) {
          return json(JSON.parse(cached));
        }
        return json({ status: 'no_data', message: 'No health check has run yet. Wait for next cron cycle or trigger /v1/fleet/check' });
      }

      // Get pending alerts
      if (path === '/v1/fleet/alerts') {
        const alerts = await env.VERIFICATION_CACHE.get('fleet:pending_alerts');
        return json(alerts ? JSON.parse(alerts) : { alerts: [], message: 'No pending alerts' });
      }

      // Fleet topology
      if (path === '/v1/fleet/topology') {
        return json({
          fleet: FLEET.map(w => ({
            name: w.name,
            url: w.url,
            critical: w.critical,
            description: w.description,
            reachable: !w.isExternal
          })),
          layers: {
            edge: ['edge-sheriff'],
            ai: ['ai-sheriff'],
            consensus: ['vetproof-consensus'],
            workflow: ['vetproof-workflow'],
            agent: ['proof-agent'],
            gating: ['vetproof-hitl'],
            orchestration: ['sentient-collective'],
            knowledge: ['regulation-tracker'],
            hardware: ['pi-sheriff']
          },
          thresholds: THRESHOLDS
        });
      }

      return json({ error: 'Not found', endpoints: [
        '/health',
        '/v1/dashboard',
        '/v1/fleet/check',
        '/v1/fleet/status',
        '/v1/fleet/uptime?period=24h|7d|30d',
        '/v1/fleet/costs',
        '/v1/fleet/alerts',
        '/v1/fleet/topology'
      ]}, 404);

    } catch (error) {
      return json({ error: error.message }, 500);
    }
  },

  // Cron handler - runs every 15 minutes
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runFleetHealthCheck(env));
  }
};
