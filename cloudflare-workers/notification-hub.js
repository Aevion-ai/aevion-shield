/**
 * Aevion Notification Hub Worker
 * Discord/email/webhook alerts for solo CEO
 * Never miss a critical event - fleet alerts, revenue milestones, compliance gaps, new leads
 *
 * Channels:
 * - Discord webhook (primary - always on)
 * - Email via Mailchannels (Cloudflare native, free)
 * - Generic webhook (for Zapier/Make/n8n)
 *
 * Alert Priority:
 * - P0 CRITICAL: Worker down, security breach, payment failure
 * - P1 HIGH: New lead, revenue milestone, compliance gap
 * - P2 MEDIUM: Demo completed, usage spike, regulation update
 * - P3 LOW: Daily digest, weekly summary
 *
 * Patent: US 63/896,282
 */

const PRIORITY = {
  P0: { label: 'CRITICAL', color: 0xFF0000, emoji: '🚨' },
  P1: { label: 'HIGH', color: 0xFF8C00, emoji: '⚠️' },
  P2: { label: 'MEDIUM', color: 0xFFD700, emoji: '📋' },
  P3: { label: 'LOW', color: 0x4169E1, emoji: 'ℹ️' },
};

// Format Discord embed
function formatDiscordEmbed(alert) {
  const priority = PRIORITY[alert.priority] || PRIORITY.P2;

  return {
    embeds: [{
      title: `${priority.emoji} ${priority.label}: ${alert.title}`,
      description: alert.message,
      color: priority.color,
      fields: alert.fields || [],
      footer: {
        text: `Aevion Truth Engine | ${alert.source || 'system'}`,
      },
      timestamp: new Date().toISOString(),
    }],
  };
}

// Send Discord notification
async function sendDiscord(env, alert) {
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return { sent: false, reason: 'No Discord webhook configured' };

  const payload = formatDiscordEmbed(alert);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    return { sent: response.ok, status: response.status };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

// Send email via MailChannels (Cloudflare Workers native)
async function sendEmail(env, alert) {
  const toEmail = env.CEO_EMAIL;
  if (!toEmail) return { sent: false, reason: 'No CEO email configured' };

  const priority = PRIORITY[alert.priority] || PRIORITY.P2;

  try {
    const response = await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{
          to: [{ email: toEmail }],
        }],
        from: {
          email: 'alerts@aevion.ai',
          name: 'Aevion Truth Engine',
        },
        subject: `[${priority.label}] ${alert.title}`,
        content: [{
          type: 'text/plain',
          value: `${priority.label}: ${alert.title}\n\n${alert.message}\n\nSource: ${alert.source || 'system'}\nTime: ${new Date().toISOString()}\n\n---\nAevion Truth Engine Alerts`,
        }],
      }),
    });

    return { sent: response.ok || response.status === 202, status: response.status };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

// Send generic webhook (for Zapier/Make/n8n integration)
async function sendWebhook(env, alert) {
  const webhookUrl = env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) return { sent: false, reason: 'No webhook URL configured' };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'aevion_alert',
        priority: alert.priority,
        title: alert.title,
        message: alert.message,
        source: alert.source,
        fields: alert.fields,
        timestamp: new Date().toISOString(),
      }),
    });

    return { sent: response.ok, status: response.status };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

// Process alert from queue
async function processAlert(env, alert) {
  const results = {
    alert: alert.title,
    priority: alert.priority,
    channels: {},
  };

  // Route based on priority
  const channels = alert.channels || getDefaultChannels(alert.priority);

  if (channels.includes('discord')) {
    results.channels.discord = await sendDiscord(env, alert);
  }
  if (channels.includes('email')) {
    results.channels.email = await sendEmail(env, alert);
  }
  if (channels.includes('webhook')) {
    results.channels.webhook = await sendWebhook(env, alert);
  }

  // Store in D1 for history
  if (env.AUDIT_DB) {
    try {
      await env.AUDIT_DB.prepare(
        `INSERT INTO audit_events (event_type, event_data, created_at) VALUES (?, ?, ?)`
      ).bind('notification', JSON.stringify({
        priority: alert.priority,
        title: alert.title,
        source: alert.source,
        channels: results.channels,
      }), new Date().toISOString()).run();
    } catch (e) {
      // Non-blocking
    }
  }

  return results;
}

// Default channel routing by priority
function getDefaultChannels(priority) {
  switch (priority) {
    case 'P0': return ['discord', 'email', 'webhook']; // Everything
    case 'P1': return ['discord', 'email']; // Discord + email
    case 'P2': return ['discord']; // Discord only
    case 'P3': return ['discord']; // Discord only (batched in digest)
    default: return ['discord'];
  }
}

// Check for pending alerts from other workers (stored in KV by fleet-health-monitor)
async function checkPendingAlerts(env) {
  if (!env.VERIFICATION_CACHE) return [];

  const alerts = [];

  // Check fleet health alerts
  try {
    const fleetAlerts = await env.VERIFICATION_CACHE.get('fleet:alerts', 'json');
    if (fleetAlerts && Array.isArray(fleetAlerts)) {
      for (const alert of fleetAlerts) {
        if (!alert.notified) {
          alerts.push({
            priority: 'P0',
            title: `Worker Down: ${alert.worker}`,
            message: `${alert.worker} has failed ${alert.consecutiveFailures} consecutive health checks. Last error: ${alert.lastError || 'timeout'}`,
            source: 'fleet-health-monitor',
            fields: [
              { name: 'Worker', value: alert.worker, inline: true },
              { name: 'Failures', value: String(alert.consecutiveFailures), inline: true },
            ],
          });
        }
      }
    }
  } catch (e) {
    // Non-blocking
  }

  // Check revenue alerts
  try {
    const revenueAlert = await env.VERIFICATION_CACHE.get('revenue:milestone', 'json');
    if (revenueAlert && !revenueAlert.notified) {
      alerts.push({
        priority: 'P1',
        title: `Revenue Milestone: ${revenueAlert.type}`,
        message: revenueAlert.message,
        source: 'revenue-gateway',
      });
    }
  } catch (e) {
    // Non-blocking
  }

  return alerts;
}

// Generate daily digest
async function generateDailyDigest(env) {
  if (!env.AUDIT_DB) return null;

  const [notifications, demos, revenue] = await Promise.all([
    env.AUDIT_DB.prepare(
      `SELECT COUNT(*) as count FROM audit_events WHERE event_type = 'notification' AND created_at > datetime('now', '-1 day')`
    ).first(),
    env.AUDIT_DB.prepare(
      `SELECT COUNT(*) as count FROM audit_events WHERE event_type = 'demo_event' AND created_at > datetime('now', '-1 day')`
    ).first(),
    env.AUDIT_DB.prepare(
      `SELECT COUNT(*) as count FROM audit_events WHERE event_type = 'api_usage' AND created_at > datetime('now', '-1 day')`
    ).first(),
  ]);

  return {
    priority: 'P3',
    title: 'Daily Digest',
    message: 'Your Aevion Truth Engine daily summary',
    source: 'notification-hub',
    fields: [
      { name: 'Alerts Sent', value: String(notifications?.count || 0), inline: true },
      { name: 'Demos Run', value: String(demos?.count || 0), inline: true },
      { name: 'API Calls', value: String(revenue?.count || 0), inline: true },
    ],
  };
}

export default {
  // HTTP API
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
          worker: 'notification-hub',
          channels: {
            discord: !!env.DISCORD_WEBHOOK_URL,
            email: !!env.CEO_EMAIL,
            webhook: !!env.ALERT_WEBHOOK_URL,
          },
          timestamp: new Date().toISOString(),
        }, { headers });
      }

      // Send alert (internal API - called by other workers or cron)
      if (path === '/v1/alert' && request.method === 'POST') {
        // Auth check
        const authHeader = request.headers.get('Authorization');
        const apiSecret = env.API_SECRET;
        if (apiSecret && (!authHeader || authHeader !== `Bearer ${apiSecret}`)) {
          return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
        }

        const alert = await request.json();
        if (!alert.title || !alert.priority) {
          return Response.json({ error: 'Missing title or priority' }, { status: 400, headers });
        }

        const result = await processAlert(env, alert);
        return Response.json(result, { headers });
      }

      // Process pending alerts from other workers
      if (path === '/v1/process-pending') {
        const authHeader = request.headers.get('Authorization');
        const apiSecret = env.API_SECRET;
        if (apiSecret && (!authHeader || authHeader !== `Bearer ${apiSecret}`)) {
          return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
        }

        const pending = await checkPendingAlerts(env);
        const results = [];

        for (const alert of pending) {
          const result = await processAlert(env, alert);
          results.push(result);
        }

        return Response.json({
          processed: results.length,
          results,
          timestamp: new Date().toISOString(),
        }, { headers });
      }

      // Get notification history
      if (path === '/v1/history') {
        const authHeader = request.headers.get('Authorization');
        const apiSecret = env.API_SECRET;
        if (apiSecret && (!authHeader || authHeader !== `Bearer ${apiSecret}`)) {
          return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
        }

        if (!env.AUDIT_DB) {
          return Response.json({ error: 'Audit DB not available' }, { status: 503, headers });
        }

        const history = await env.AUDIT_DB.prepare(
          `SELECT event_data, created_at FROM audit_events WHERE event_type = 'notification' ORDER BY created_at DESC LIMIT 50`
        ).all();

        const notifications = (history.results || []).map(row => {
          try {
            return { ...JSON.parse(row.event_data), created_at: row.created_at };
          } catch (e) {
            return { raw: row.event_data, created_at: row.created_at };
          }
        });

        return Response.json({ notifications, count: notifications.length }, { headers });
      }

      // Test notification (send a test to all configured channels)
      if (path === '/v1/test') {
        const authHeader = request.headers.get('Authorization');
        const apiSecret = env.API_SECRET;
        if (apiSecret && (!authHeader || authHeader !== `Bearer ${apiSecret}`)) {
          return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
        }

        const testAlert = {
          priority: 'P3',
          title: 'Notification Test',
          message: 'This is a test alert from Aevion Notification Hub. All channels are working.',
          source: 'notification-hub-test',
          channels: ['discord', 'email', 'webhook'],
        };

        const result = await processAlert(env, testAlert);
        return Response.json(result, { headers });
      }

      // Channel config status
      if (path === '/v1/channels') {
        return Response.json({
          discord: {
            configured: !!env.DISCORD_WEBHOOK_URL,
            description: 'Real-time alerts to Discord channel',
          },
          email: {
            configured: !!env.CEO_EMAIL,
            description: 'Critical alerts via email (MailChannels)',
          },
          webhook: {
            configured: !!env.ALERT_WEBHOOK_URL,
            description: 'Generic webhook for Zapier/Make/n8n',
          },
          routing: {
            P0: 'discord + email + webhook',
            P1: 'discord + email',
            P2: 'discord',
            P3: 'discord (daily digest)',
          },
        }, { headers });
      }

      return Response.json({
        error: 'Not found',
        endpoints: [
          'GET  /v1/channels - Channel configuration status',
          'POST /v1/alert - Send an alert (admin)',
          'GET  /v1/process-pending - Process pending alerts from other workers',
          'GET  /v1/history - Notification history (admin)',
          'GET  /v1/test - Send test notification (admin)',
        ],
      }, { status: 404, headers });

    } catch (err) {
      return Response.json({ error: 'Internal error', message: err.message }, { status: 500, headers });
    }
  },

  // Cron trigger - check for pending alerts and send daily digest
  async scheduled(event, env, ctx) {
    const cronType = event.cron;

    // Every 5 minutes: process pending alerts
    if (cronType === '*/5 * * * *') {
      const pending = await checkPendingAlerts(env);
      for (const alert of pending) {
        await processAlert(env, alert);
      }
    }

    // Daily at 8am CT (2pm UTC): send digest
    if (cronType === '0 14 * * *') {
      const digest = await generateDailyDigest(env);
      if (digest) {
        await processAlert(env, digest);
      }
    }
  },
};
