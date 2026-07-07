/**
 * POST /api/lead — lead capture from the Lot Check page.
 *
 * Three kinds of lead, one endpoint:
 *   kind "callback" (default) — name + phone required. The core conversion.
 *   kind "handbook"           — email required (name optional). The ADU Handbook download.
 *   kind "pro"                — name + phone required. Contractor / investor lane.
 * All kinds may carry qualification fields (goal / owner / timeline) and attribution.
 *
 * A lead is captured two ways, for redundancy so one never silently evaporates:
 *   1. Stored to D1 (when the DB binding exists — see wrangler.toml + schema.sql).
 *   2. Pushed in real time to LEAD_WEBHOOK_URL (a Slack / Zapier / Make / Discord
 *      incoming webhook — set it as a secret). This is what actually pages a human.
 *
 * The endpoint only returns ok:true when at least one of those captured the lead.
 * If neither is configured (or both fail), it returns ok:false so the page can
 * honestly tell the visitor to call, instead of falsely claiming they're queued.
 *
 * Set at least one of D1 or LEAD_WEBHOOK_URL before launch.
 */
export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, message: 'Invalid request.' }, 400);
  }

  const KINDS = ['callback', 'handbook', 'pro'];
  const kind = KINDS.includes(body.kind) ? body.kind : 'callback';

  const lead = {
    kind,
    name: clean(body.name, 120),
    phone: clean(body.phone, 40),
    email: clean(body.email, 160),
    company: clean(body.company, 120),
    address: clean(body.address, 200),
    verdict: clean(body.verdict, 20),
    goal: clean(body.goal, 40),
    owner: clean(body.owner, 40),
    timeline: clean(body.timeline, 40),
    source: clean(body.source, 300), // utm / referrer captured by the page
    userAgent: request.headers.get('user-agent') || '',
  };

  if (kind === 'handbook') {
    if (!lead.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
      return json({ ok: false, message: 'A valid email is required.' }, 400);
    }
  } else if (!lead.name || !lead.phone) {
    return json({ ok: false, message: 'Name and phone are required.' }, 400);
  }

  let captured = false;

  // 1) Persist to D1 when bound.
  if (env.DB) {
    try {
      await env.DB.prepare(
        'INSERT INTO leads (kind, name, phone, email, company, address, verdict, goal, owner, timeline, source, user_agent) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(lead.kind, lead.name, lead.phone, lead.email, lead.company, lead.address, lead.verdict,
              lead.goal, lead.owner, lead.timeline, lead.source, lead.userAgent)
        .run();
      captured = true;
    } catch (err) {
      console.error('lead insert failed', err, lead);
    }
  }

  // 2) Real-time alert. If already stored, fire in the background (don't make the
  // homeowner wait). If nothing stored it yet, await it so we know the lead landed.
  if (env.LEAD_WEBHOOK_URL) {
    if (captured && typeof waitUntil === 'function') {
      waitUntil(notify(env.LEAD_WEBHOOK_URL, lead).catch(() => {}));
    } else {
      captured = (await notify(env.LEAD_WEBHOOK_URL, lead).catch(() => false)) || captured;
    }
  }

  if (!captured) {
    console.error('LEAD NOT CAPTURED — no DB bound and no LEAD_WEBHOOK_URL set, or both failed', lead);
    return json({
      ok: false,
      message:
        'We couldn’t log that just now — please call us at 323.566.8096 and we’ll pick it right up.',
    });
  }

  return json({ ok: true });
}

const KIND_TITLES = {
  callback: 'New Lot Check lead',
  handbook: 'New ADU Handbook download (email lead)',
  pro: 'New contractor/investor lead',
};

async function notify(url, lead, timeoutMs = 4000) {
  const lines = [
    KIND_TITLES[lead.kind] || KIND_TITLES.callback,
    lead.name ? `Name: ${lead.name}` : '',
    lead.phone ? `Phone: ${lead.phone}` : '',
    lead.email ? `Email: ${lead.email}` : '',
    lead.company ? `Company: ${lead.company}` : '',
    lead.address ? `Address: ${lead.address}` : '',
    lead.verdict ? `Verdict: ${lead.verdict}` : '',
    lead.goal ? `Goal: ${lead.goal}` : '',
    lead.owner ? `Owner: ${lead.owner}` : '',
    lead.timeline ? `Timeline: ${lead.timeline}` : '',
    lead.source ? `Source: ${lead.source}` : '',
  ].filter(Boolean);
  const text = lines.join('\n');

  // text -> Slack, content -> Discord, lead -> raw object for Zapier/Make/etc.
  const payload = JSON.stringify({ text, content: text, lead });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function clean(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
