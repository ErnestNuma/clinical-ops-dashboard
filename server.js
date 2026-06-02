const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'client')));

// ─────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────
const JWT_SECRET  = process.env.DASHBOARD_JWT_SECRET || 'titan-secret-change-in-production';
const ADMIN_USER  = process.env.DASHBOARD_USER       || 'ernest';
const ADMIN_PASS  = process.env.DASHBOARD_PASS       || 'clinicflow2026';
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const PORT        = process.env.PORT || process.env.DASHBOARD_PORT || 3999;

const CHANNELS = {
  wins:       'C0B7ARR75QS',
  standup:    'C0B74EK0E7M',
  ops_alerts: 'C0B76QK3DGD',
  sales:      'C0B7CKNQFRS',
  dev:        'C0B76V0FQAJ',
  onboarding: 'C0B75KPAJMB',
};

// ─────────────────────────────────────────
// POSTGRES
// ─────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false }
});

async function db(text, params) {
  const client = await pool.connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

// ─────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No authorization header' });
  const token = header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─────────────────────────────────────────
// SLACK HELPER — with full logging
// ─────────────────────────────────────────
async function slackPost(channel, text, blocks) {
  if (!SLACK_TOKEN) {
    console.error('[SLACK] SLACK_BOT_TOKEN not set — cannot post');
    return { ok: false, error: 'missing_token' };
  }
  try {
    const body = { channel, text };
    if (blocks) body.blocks = blocks;

    console.log(`[SLACK] Posting to channel: ${channel}`);

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SLACK_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (data.ok) {
      console.log(`[SLACK] ✅ Posted to ${channel}`);
    } else {
      console.error(`[SLACK] ❌ Error: ${data.error} | channel: ${channel}`);
    }

    return data;
  } catch (err) {
    console.error(`[SLACK] ❌ Fetch error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
function genId() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// ─────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (username !== ADMIN_USER || password !== ADMIN_PASS) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
  console.log(`[AUTH] Login: ${username}`);
  res.json({ token, username });
});

app.get('/api/me', auth, (req, res) => res.json(req.user));

// ─────────────────────────────────────────
// OVERVIEW
// ─────────────────────────────────────────
app.get('/api/overview', auth, async (req, res) => {
  try {
    const today = todayStr();
    const [
      tasks, blocked, bugs, critBugs, leads, wonLeads,
      onbs, completedOnbs, standups, metricsRes, interactions, unknowns
    ] = await Promise.all([
      db(`SELECT COUNT(*) FROM tasks WHERE status='open'`),
      db(`SELECT COUNT(*) FROM tasks WHERE status='blocked'`),
      db(`SELECT COUNT(*) FROM bugs WHERE status='open'`),
      db(`SELECT COUNT(*) FROM bugs WHERE status='open' AND sev_val='critical'`),
      db(`SELECT COUNT(*) FROM leads WHERE status NOT IN ('won','lost')`),
      db(`SELECT COUNT(*) FROM leads WHERE status='won'`),
      db(`SELECT COUNT(*) FROM onboardings WHERE status='in_progress'`),
      db(`SELECT COUNT(*) FROM onboardings WHERE status='complete'`),
      db(`SELECT COUNT(*) FROM standup_log WHERE date=$1`, [today]),
      db(`SELECT key, value FROM metrics`),
      db(`SELECT COUNT(*) FROM interaction_log`),
      db(`SELECT COUNT(*) FROM interaction_log WHERE was_hit=false`),
    ]);

    const m  = Object.fromEntries(metricsRes.rows.map(r => [r.key, parseInt(r.value)]));
    const ot = parseInt(tasks.rows[0].count);
    const bl = parseInt(blocked.rows[0].count);
    const ob = parseInt(bugs.rows[0].count);
    const cb = parseInt(critBugs.rows[0].count);
    const health = (cb > 0 || bl > 3) ? 'red' : (ob > 5 || bl > 1 || ot > 15) ? 'yellow' : 'green';

    res.json({
      health,
      openTasks:         ot,
      blockedTasks:      bl,
      openBugs:          ob,
      criticalBugs:      cb,
      activeLeads:       parseInt(leads.rows[0].count),
      wonLeads:          parseInt(wonLeads.rows[0].count),
      activeOnbs:        parseInt(onbs.rows[0].count),
      completedOnbs:     parseInt(completedOnbs.rows[0].count),
      standupsToday:     parseInt(standups.rows[0].count),
      totalInteractions: parseInt(interactions.rows[0].count),
      unknownMessages:   parseInt(unknowns.rows[0].count),
      metrics:           m
    });
  } catch (e) {
    console.error('[OVERVIEW]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// TASKS
// ─────────────────────────────────────────
app.get('/api/tasks', auth, async (req, res) => {
  try {
    const { status, area, assignee } = req.query;
    let q = `SELECT * FROM tasks WHERE 1=1`;
    const params = [];
    if (status && status !== 'all') {
      params.push(status);
      q += ` AND status=$${params.length}`;
    }
    if (area) {
      params.push(`%${area}%`);
      q += ` AND LOWER(area) LIKE $${params.length}`;
    }
    if (assignee) {
      params.push(assignee);
      q += ` AND assignee=$${params.length}`;
    }
    q += ` ORDER BY created_at DESC`;
    const r = await db(q, params);
    res.json(r.rows);
  } catch (e) {
    console.error('[TASKS GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tasks', auth, async (req, res) => {
  try {
    const { title, assignee, priority, area, dueDate } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const id    = genId();
    const today = todayStr();

    await db(
      `INSERT INTO tasks (id, title, assignee, priority, area, due_date, status, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8)`,
      [id, title, assignee || '', priority || '🟡 Medium', area || 'ops', dueDate || 'No due date', 'dashboard', today]
    );

    const slackResult = await slackPost(
      CHANNELS.dev,
      `✅ *New Task — \`${id}\`*\n\n*${title}*\n*Priority:* ${priority} | *Area:* ${area}${assignee ? ` | *Assigned:* <@${assignee}>` : ''}\n_Created via TITAN Dashboard_`
    );

    res.json({ id, title, status: 'open', slackOk: slackResult.ok });
  } catch (e) {
    console.error('[TASKS POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/tasks/:id', auth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'Status required' });
    await db(`UPDATE tasks SET status=$1 WHERE id=$2`, [status, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('[TASKS PATCH]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/tasks/:id', auth, async (req, res) => {
  try {
    await db(`DELETE FROM tasks WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('[TASKS DELETE]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// LEADS
// ─────────────────────────────────────────
app.get('/api/leads', auth, async (req, res) => {
  try {
    const r = await db(`SELECT * FROM leads ORDER BY created_at DESC`);
    res.json(r.rows);
  } catch (e) {
    console.error('[LEADS GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/leads', auth, async (req, res) => {
  try {
    const { clinicName, contact, stage, notes } = req.body;
    if (!clinicName) return res.status(400).json({ error: 'Clinic name required' });

    const id    = genId();
    const today = todayStr();
    const stageVal = stage || '📞 First Contact';

    await db(
      `INSERT INTO leads (id, clinic_name, contact, stage, status, notes, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'dashboard',$7)`,
      [id, clinicName, contact || '', stageVal, stageVal, notes || '', today]
    );

    const slackResult = await slackPost(
      CHANNELS.sales,
      `💰 *New Lead — \`${id}\`*\n\n*${clinicName}* | ${contact} | Stage: ${stageVal}\n_Added via TITAN Dashboard_`
    );

    res.json({ id, clinicName, status: stageVal, slackOk: slackResult.ok });
  } catch (e) {
    console.error('[LEADS POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/leads/:id', auth, async (req, res) => {
  try {
    const { status, stage } = req.body;
    await db(
      `UPDATE leads SET status=$1, stage=$2 WHERE id=$3`,
      [status, stage || status, req.params.id]
    );

    if (status === 'won') {
      await db(`UPDATE metrics SET value=value+1 WHERE key='newClients'`);
      const lead = await db(`SELECT clinic_name FROM leads WHERE id=$1`, [req.params.id]);
      await slackPost(
        CHANNELS.wins,
        `🎉 *CLOSED WON!*\n\n*${lead.rows[0]?.clinic_name}* is now a ClinicFlow client!\n_Closed via TITAN Dashboard_ 🚀`
      );
    }

    res.json({ success: true });
  } catch (e) {
    console.error('[LEADS PATCH]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// BUGS
// ─────────────────────────────────────────
app.get('/api/bugs', auth, async (req, res) => {
  try {
    const r = await db(`SELECT * FROM bugs ORDER BY created_at DESC`);
    res.json(r.rows);
  } catch (e) {
    console.error('[BUGS GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/bugs', auth, async (req, res) => {
  try {
    const { title, severity, sevVal, steps, assignee } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });

    const id    = genId();
    const today = todayStr();

    await db(
      `INSERT INTO bugs (id, title, severity, sev_val, steps, assignee, status, reported_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'open','dashboard',$7)`,
      [id, title, severity || '🟡 Medium', sevVal || 'medium', steps || '', assignee || '', today]
    );

    await db(`UPDATE metrics SET value=value+1 WHERE key='bugsReported'`);

    const targetChannel = sevVal === 'critical' ? CHANNELS.ops_alerts : CHANNELS.dev;
    await slackPost(
      targetChannel,
      `🐛 *Bug Report — \`${id}\`*${sevVal === 'critical' ? '\n\n🚨 *CRITICAL — IMMEDIATE ATTENTION*' : ''}\n\n*${title}*\n*Severity:* ${severity}${assignee ? `\n*Assigned:* <@${assignee}>` : ''}\n_Reported via TITAN Dashboard_`
    );

    res.json({ id, title, status: 'open' });
  } catch (e) {
    console.error('[BUGS POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/bugs/:id', auth, async (req, res) => {
  try {
    const { status } = req.body;
    await db(`UPDATE bugs SET status=$1 WHERE id=$2`, [status, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('[BUGS PATCH]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// ONBOARDINGS
// ─────────────────────────────────────────
app.get('/api/onboardings', auth, async (req, res) => {
  try {
    const r = await db(`SELECT * FROM onboardings ORDER BY created_at DESC`);
    res.json(r.rows);
  } catch (e) {
    console.error('[ONBOARDINGS GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/onboardings', auth, async (req, res) => {
  try {
    const { clinicName, owner, contact } = req.body;
    if (!clinicName) return res.status(400).json({ error: 'Clinic name required' });

    const id    = genId();
    const today = todayStr();
    const steps = [
      'Kick-off call scheduled',
      'WhatsApp / Meta integration configured',
      'Staff accounts created',
      'Training session completed',
      'Go-live confirmed',
      'First week check-in done'
    ].map((s, i) => ({ step: i + 1, title: s, done: false }));

    await db(
      `INSERT INTO onboardings (id, clinic_name, owner, contact, steps, status, created_at)
       VALUES ($1,$2,$3,$4,$5,'in_progress',$6)`,
      [id, clinicName, owner || '', contact || '', JSON.stringify(steps), today]
    );

    await slackPost(
      CHANNELS.onboarding,
      `🏥 *Onboarding Started — \`${id}\`*\n\n*${clinicName}* | Contact: ${contact}\n_Started via TITAN Dashboard_`
    );

    res.json({ id, clinicName, status: 'in_progress' });
  } catch (e) {
    console.error('[ONBOARDINGS POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/onboardings/:id/step', auth, async (req, res) => {
  try {
    const { stepIndex } = req.body;
    const r  = await db(`SELECT * FROM onboardings WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Onboarding not found' });

    const ob = r.rows[0];
    ob.steps[stepIndex].done = true;
    const allDone = ob.steps.every(s => s.done);

    await db(
      `UPDATE onboardings SET steps=$1, status=$2 WHERE id=$3`,
      [JSON.stringify(ob.steps), allDone ? 'complete' : 'in_progress', req.params.id]
    );

    if (allDone) {
      await slackPost(CHANNELS.wins, `🎉 *${ob.clinic_name}* fully onboarded on ClinicFlow! 🚀`);
    }

    res.json({ success: true, allDone });
  } catch (e) {
    console.error('[ONBOARDINGS STEP]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// STANDUPS
// ─────────────────────────────────────────
app.get('/api/standups', auth, async (req, res) => {
  try {
    const date = req.query.date || todayStr();
    const r = await db(`SELECT * FROM standup_log WHERE date=$1 ORDER BY user_id`, [date]);
    res.json(r.rows);
  } catch (e) {
    console.error('[STANDUPS]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// INTERACTIONS
// ─────────────────────────────────────────
app.get('/api/interactions', auth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const r = await db(
      `SELECT * FROM interaction_log ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('[INTERACTIONS]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/interactions/unknowns', auth, async (req, res) => {
  try {
    const r = await db(
      `SELECT normalized_text, COUNT(*) as count, MAX(created_at) as last_seen, MAX(user_id) as user_id
       FROM interaction_log WHERE was_hit=false
       GROUP BY normalized_text ORDER BY count DESC LIMIT 30`
    );
    res.json(r.rows);
  } catch (e) {
    console.error('[UNKNOWNS]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/interactions/stats', auth, async (req, res) => {
  try {
    const [total, hits, topIntents, topUsers, byDay, claudeCalls] = await Promise.all([
      db(`SELECT COUNT(*) FROM interaction_log`),
      db(`SELECT COUNT(*) FROM interaction_log WHERE was_hit=true`),
      db(`SELECT intent_matched, COUNT(*) as cnt FROM interaction_log GROUP BY intent_matched ORDER BY cnt DESC LIMIT 10`),
      db(`SELECT user_id, COUNT(*) as cnt FROM interaction_log GROUP BY user_id ORDER BY cnt DESC LIMIT 5`),
      db(`SELECT day_of_week, COUNT(*) as cnt FROM interaction_log GROUP BY day_of_week ORDER BY cnt DESC`),
      db(`SELECT COUNT(*) FROM interaction_log WHERE intent_matched='claude'`),
    ]);

    const t = parseInt(total.rows[0].count);
    const h = parseInt(hits.rows[0].count);

    res.json({
      total:       t,
      hits:        h,
      misses:      t - h,
      hitRate:     t > 0 ? Math.round((h / t) * 100) : 0,
      claudeCalls: parseInt(claudeCalls.rows[0].count),
      topIntents:  topIntents.rows,
      topUsers:    topUsers.rows,
      byDay:       byDay.rows
    });
  } catch (e) {
    console.error('[STATS]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// LEARNED PATTERNS
// ─────────────────────────────────────────
app.get('/api/patterns', auth, async (req, res) => {
  try {
    const r = await db(`SELECT * FROM learned_patterns ORDER BY use_count DESC`);
    res.json(r.rows);
  } catch (e) {
    console.error('[PATTERNS GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/patterns', auth, async (req, res) => {
  try {
    const { triggerPhrase, intentTarget } = req.body;
    if (!triggerPhrase || !intentTarget) {
      return res.status(400).json({ error: 'Trigger phrase and intent target required' });
    }
    const r = await db(
      `INSERT INTO learned_patterns (trigger_phrase, intent_target, taught_by)
       VALUES ($1,$2,'dashboard') RETURNING *`,
      [triggerPhrase.toLowerCase().trim(), intentTarget.toLowerCase().trim()]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error('[PATTERNS POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/patterns/:id', auth, async (req, res) => {
  try {
    const { active } = req.body;
    await db(`UPDATE learned_patterns SET active=$1 WHERE id=$2`, [active, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('[PATTERNS PATCH]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/patterns/:id', auth, async (req, res) => {
  try {
    await db(`DELETE FROM learned_patterns WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('[PATTERNS DELETE]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// SLACK ACTIONS
// ─────────────────────────────────────────
app.post('/api/slack/announce', auth, async (req, res) => {
  try {
    const { channel, message } = req.body;
    if (!channel || !message) return res.status(400).json({ error: 'Channel and message required' });
    const channelId = CHANNELS[channel] || channel;
    const r = await slackPost(channelId, `📢 *ANNOUNCEMENT*\n\n${message}\n\n_Posted via TITAN Dashboard_`);
    res.json({ success: r.ok, error: r.error });
  } catch (e) {
    console.error('[ANNOUNCE]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/slack/briefing', auth, async (req, res) => {
  try {
    const r = await slackPost(
      CHANNELS.standup,
      `⚡ *TITAN BRIEFING*\n\n_Manually triggered from Dashboard at ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/El_Salvador' })}_\n\nCheck the dashboard for live metrics or use \`/report\` in Slack.`
    );
    res.json({ success: r.ok, error: r.error });
  } catch (e) {
    console.error('[BRIEFING]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/slack/poll', auth, async (req, res) => {
  try {
    const { channel, question } = req.body;
    if (!question) return res.status(400).json({ error: 'Question required' });
    const channelId = CHANNELS[channel] || CHANNELS.standup;
    const r = await slackPost(channelId, `📊 *Poll:* ${question}\n\n👍 Yes   |   👎 No   |   🤷 Maybe\n\n_Posted via TITAN Dashboard_`);
    res.json({ success: r.ok, error: r.error });
  } catch (e) {
    console.error('[POLL]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/slack/new-win', auth, async (req, res) => {
  try {
    const { clinicName, industry } = req.body;
    if (!clinicName) return res.status(400).json({ error: 'Clinic name required' });
    const r = await slackPost(
      CHANNELS.wins,
      `🚀 *NEW CLINICFLOW CLIENT!*\n\n*Clinic:* ${clinicName}\n*Industry:* ${industry || 'Healthcare'}\n\nLet's keep building! <!here>\n\n_Announced via TITAN Dashboard_`
    );
    if (r.ok) await db(`UPDATE metrics SET value=value+1 WHERE key='newClients'`);
    res.json({ success: r.ok, error: r.error });
  } catch (e) {
    console.error('[NEW-WIN]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/slack/reflection', auth, async (req, res) => {
  try {
    const r = await slackPost(
      CHANNELS.standup,
      `⌛ *End of Day — ClinicFlow Team*\n\n1. What did you ship/close today?\n2. Any blockers for tomorrow?\n3. Team energy: 🔥 High / ⚡ Medium / 😴 Low\n\n_Triggered via TITAN Dashboard_`
    );
    res.json({ success: r.ok, error: r.error });
  } catch (e) {
    console.error('[REFLECTION]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// UPTIME CHECK
// ─────────────────────────────────────────
app.get('/api/uptime', auth, async (req, res) => {
  try {
    const start = Date.now();
    const response = await fetch('https://clinicflow.lat', {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'TITAN-Dashboard/2.0' }
    });
    const latency = Date.now() - start;
    res.json({
      status:     response.ok || response.status < 500 ? 'up' : 'degraded',
      statusCode: response.status,
      latency
    });
  } catch (e) {
    res.json({ status: 'down', error: e.message, latency: null });
  }
});

// ─────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────
// SERVE REACT APP
// ─────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'index.html'));
});

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────
pool.connect()
  .then(() => {
    console.log('[DB] ✅ Connected to Postgres');
    if (!SLACK_TOKEN) {
      console.warn('[SLACK] ⚠️  SLACK_BOT_TOKEN not set — Slack notifications disabled');
    } else {
      console.log('[SLACK] ✅ Bot token loaded');
    }
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[SERVER] ⚡ TITAN Dashboard running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('[DB] ❌ Connection failed:', err.message);
    process.exit(1);
  });
