/* Diaz Blueprint — Lot Check frontend
   Feasibility: POSTs to /api/check (Cloudflare Pages Function, live county data).
   Leads (callback / handbook / pro): POST to Formspree via submitLead() — set
   FORMSPREE_ENDPOINT below. Until it's set, submitLead resolves ok:false so the
   page honestly routes to the phone instead of faking a captured lead.
   Qualification is never a gate: goal chips sit by the hero form, the owner
   question fills the loading wait, timeline is asked on the result card. All
   answers are optional and ride along with the lead payload. */

(function () {
  const resultsSection = document.getElementById('results');
  const loadingEl = document.getElementById('results-loading');
  const loadingStep = document.getElementById('loading-step');
  const loadingQ = document.getElementById('loading-q');
  const cardEl = document.getElementById('results-card');

  const VERDICTS = {
    yes: { cls: 'dbp-verdict--yes', label: 'YOUR LOT CHECK RESULT', title: 'Likely Buildable' },
    conditions: { cls: 'dbp-verdict--conditions', label: 'YOUR LOT CHECK RESULT', title: 'Likely Buildable — with conditions' },
    look: { cls: 'dbp-verdict--look', label: 'YOUR LOT CHECK RESULT', title: 'Needs a Closer Look' },
  };

  const LOADING_STEPS = [
    'Finding your parcel',
    'Reading lot size and land use',
    'Applying California ADU rules',
    'Putting your results in plain English',
  ];

  // Goal-tailored next-step lines (result card). Keys match the hero chips.
  const GOAL_LINES = {
    family: 'You said this is for family. If the lot holds it, we’ll talk about what keeps a parent close but comfortable — the kind of plan we’ve drawn since 1991.',
    kids: 'You said it’s for your grown kids. If the lot holds it, we’ll talk about a place that lets them stay in the neighborhood — close to family, with their own front door.',
    rental: 'You said rental income. We won’t promise a rent number — nobody can promise you that. We can tell you what’s likely buildable and what it likely costs; the rest is your math.',
    office: 'You said office or studio. Smaller footprints clear lot problems more often — worth an honest look at what your setbacks leave you.',
    legacy: 'You said it’s for the next generation. Drawn right and permitted, one property can carry two generations — worth doing on paper, the legal way.',
  };

  // Verdict-tailored lead-ask line, directly above the form.
  const VERDICT_ASKS = {
    yes: 'Your lot looks likely. The next step is a human read of the details — free, on the phone, before you spend anything.',
    conditions: 'Conditions are where 35 years earns its keep. Ask us what your version of workable looks like — the call is free either way.',
    look: 'The records couldn’t give you a straight answer. A person can — free. And if the answer is no, you’ll have it before you’ve spent a dollar.',
  };

  // Owner-status additions to the lead microcopy.
  const OWNER_NOTES = {
    helping: 'Bring them into the call — we’ll talk with whoever the decision belongs to, in English or Spanish.',
    looking: 'Checking before you buy is the right order. We can read the lot before you’re locked in.',
  };

  let stepTimer = null;
  let checking = false;
  const SCROLL = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  const srStatus = document.getElementById('sr-status');

  // Qualification state — all optional, captured without gating anything.
  const qual = { goal: '', owner: '', timeline: '', callfor: 'me' };

  // Capture where this visit came from (UTM tags / referrer) once, for lead
  // attribution. Stored with the lead so we can tell which channel converts.
  const LEAD_SOURCE = (function () {
    try {
      const p = new URLSearchParams(location.search);
      const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'];
      const parts = [];
      keys.forEach((k) => { const v = p.get(k); if (v) parts.push(k + '=' + v); });
      if (!parts.length && document.referrer) parts.push('ref=' + document.referrer);
      return parts.join('&').slice(0, 300);
    } catch (e) {
      return '';
    }
  })();

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Analytics — GA4 events. Guarded so a missing/blocked gtag never throws.
  function track(name, params) {
    try { if (typeof window.gtag === 'function') window.gtag('event', name, params || {}); } catch (e) {}
  }

  /* ---------- Lead capture via Formspree ----------
     Create a form at formspree.io and paste its endpoint below — it looks like
     https://formspree.io/f/abcdwxyz . One form handles all three lead kinds; the
     _subject line tells them apart in the inbox. Until the real ID is pasted,
     submitLead resolves ok:false and the page tells the visitor to call. */
  const FORMSPREE_ENDPOINT = 'https://formspree.io/f/xnjkynpz';
  const LEAD_SUBJECTS = {
    callback: 'New Lot Check lead — callback',
    handbook: 'New ADU Handbook download',
    pro: 'New contractor / investor lead',
  };
  function submitLead(payload) {
    if (!FORMSPREE_ENDPOINT || FORMSPREE_ENDPOINT.indexOf('REPLACE_WITH_FORM_ID') !== -1) {
      return Promise.resolve({ ok: false }); // not configured — never fake a capture
    }
    const body = Object.assign({ _subject: LEAD_SUBJECTS[payload.kind] || LEAD_SUBJECTS.callback }, payload);
    return fetch(FORMSPREE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => {
        if (r.ok) track('generate_lead', { lead_type: payload.kind });
        return { ok: r.ok };
      })
      .catch(() => ({ ok: false }));
  }

  /* ---------- Hero goal chips: one tap, relabels the site-plan casita ---------- */
  const planLabel = document.getElementById('plan-casita-label');
  document.querySelectorAll('.lc-goalrow .lc-chipbtn').forEach((btn) => {
    btn.addEventListener('click', function () {
      const on = btn.classList.contains('lc-chipbtn--on');
      document.querySelectorAll('.lc-goalrow .lc-chipbtn').forEach((b) => { b.classList.remove('lc-chipbtn--on'); b.setAttribute('aria-pressed', 'false'); });
      const setLabel = (t) => {
        if (!planLabel) return;
        planLabel.textContent = t;
        planLabel.classList.toggle('plan-label--small', t.length > 8);
      };
      if (on) {
        qual.goal = '';
        setLabel('CASITA');
      } else {
        btn.classList.add('lc-chipbtn--on');
        btn.setAttribute('aria-pressed', 'true');
        qual.goal = btn.dataset.goal;
        setLabel(btn.dataset.planLabel || 'CASITA');
      }
    });
  });

  /* ---------- Loading-wait owner question (optional, never delays results) ---------- */
  function showOwnerQuestion() {
    if (!loadingQ) return;
    if (qual.owner) { loadingQ.hidden = true; return; }
    loadingQ.hidden = false;
  }
  if (loadingQ) {
    loadingQ.querySelectorAll('[data-owner]').forEach((btn) => {
      btn.addEventListener('click', function () {
        qual.owner = btn.dataset.owner;
        loadingQ.innerHTML = '<p class="lc-loading-q__label" tabindex="-1">Got it. Your answer will speak to that.</p>';
        const msg = loadingQ.querySelector('p');
        if (msg) msg.focus({ preventScroll: true });
      });
    });
    const skip = document.getElementById('owner-skip');
    if (skip) skip.addEventListener('click', function () { loadingQ.hidden = true; });
  }

  function startLoading() {
    resultsSection.hidden = false;
    cardEl.hidden = true;
    loadingEl.hidden = false;
    let i = 0;
    loadingStep.textContent = LOADING_STEPS[0];
    if (srStatus) srStatus.textContent = 'Reading your lot — results will appear below.';
    stepTimer = setInterval(() => {
      i = Math.min(i + 1, LOADING_STEPS.length - 1);
      loadingStep.textContent = LOADING_STEPS[i];
    }, 2200);
    showOwnerQuestion();
    resultsSection.scrollIntoView({ behavior: SCROLL, block: 'start' });
  }

  function stopLoading() {
    clearInterval(stepTimer);
    loadingEl.hidden = true;
  }

  function typeChip(t) {
    const cls = t.status === 'eligible' ? ' dbp-chip--eligible' : t.status === 'maybe' ? ' dbp-chip--maybe' : '';
    return (
      '<div class="dbp-chip' + cls + '">' +
      '<span class="dbp-chip__name">' + esc(t.name) + '</span>' +
      '<span class="dbp-chip__note">' + esc(t.note) + '</span>' +
      '</div>'
    );
  }

  function render(data) {
    const v = VERDICTS[data.verdict] || VERDICTS.look;

    // Per-card qualification state resets so a second check never submits
    // answers the fresh card doesn't show.
    qual.timeline = '';
    qual.callfor = 'me';
    if (qual.ownerInferred) { qual.owner = ''; qual.ownerInferred = false; }

    let html = '<div class="dbp-result">';

    html +=
      '<div class="dbp-verdict ' + v.cls + '">' +
      '<div class="dbp-verdict__label">' + v.label + '</div>' +
      '<h2 class="dbp-verdict__title" tabindex="-1">' + esc(v.title) + '</h2>' +
      (data.matchedAddress
        ? '<p class="dbp-verdict__sub">' + esc(data.matchedAddress) +
          (data.county ? ' · ' + esc(data.county) + ' County' : '') + '</p>'
        : '') +
      '</div>';

    html += '<div class="dbp-result__body">';

    if (data.headline) {
      html += '<div class="lc-result-section"><p>' + esc(data.headline) + '</p></div>';
    }

    if (data.facts && data.facts.length) {
      html +=
        '<div class="lc-result-section"><h4>Your lot, from county records</h4><div class="lc-facts">' +
        data.facts.map(f =>
          '<span class="dbp-stat"><span class="dbp-stat__num">' + esc(f.num) + '</span>' +
          '<span class="dbp-stat__label">' + esc(f.label) + '</span></span>'
        ).join('') +
        '</div></div>';
    }

    if (data.types && data.types.length) {
      html +=
        '<div class="lc-result-section"><h4>What likely fits</h4><div class="dbp-grid">' +
        data.types.map(typeChip).join('') +
        '</div></div>';
    }

    if (data.costs && data.costs.length) {
      html +=
        '<div class="lc-result-section"><h4>Ballpark cost to build</h4><div class="dbp-grid">' +
        data.costs.map(c =>
          '<div class="dbp-chip"><span class="dbp-chip__name">' + esc(c.name) + '</span>' +
          '<span class="dbp-chip__note">' + esc(c.range) + (c.note ? ' · ' + esc(c.note) : '') + '</span></div>'
        ).join('') +
        '</div></div>';
    }

    if (data.notes && data.notes.length) {
      html +=
        '<div class="lc-result-section"><h4>Worth knowing</h4><ul class="dbp-bullets">' +
        data.notes.map(n => '<li>' + esc(n) + '</li>').join('') +
        '</ul></div>';
    }

    // ----- Your next step: API line + goal line + verdict-tailored ask -----
    const goalLine = GOAL_LINES[qual.goal] || '';
    const verdictAsk = VERDICT_ASKS[data.verdict] || VERDICT_ASKS.look;
    const ownerNote = OWNER_NOTES[qual.owner] || '';

    html +=
      '<div class="lc-result-next"><h4>Your next step</h4>' +
      '<p>' + esc(data.nextStep || 'Call us and we’ll walk you through it — no pressure either way.') + '</p>' +
      (goalLine ? '<p class="lc-goal-line">' + esc(goalLine) + '</p>' : '') +
      '<p class="lc-verdict-ask">' + esc(verdictAsk) + '</p>' +

      '<div class="lc-timeline" role="group" aria-label="When would you want to start?">' +
      '<span class="lc-timeline__label">When would you want to start?</span>' +
      '<button type="button" class="lc-chipbtn" aria-pressed="false" data-timeline="now">Ready now</button>' +
      '<button type="button" class="lc-chipbtn" aria-pressed="false" data-timeline="year">Within a year</button>' +
      '<button type="button" class="lc-chipbtn" aria-pressed="false" data-timeline="exploring">Just exploring</button>' +
      '</div>' +
      '<p class="lc-exploring-note" id="exploring-note" hidden>Exploring is fine. The handbook further down this page is made for that — and the number works whenever you’re ready.</p>' +

      '<div class="lc-callfor" role="group" aria-label="Who should we call?">' +
      '<span class="lc-timeline__label">Who should we call?</span>' +
      '<button type="button" class="lc-chipbtn lc-chipbtn--on" aria-pressed="true" data-callfor="me">Call me — it’s my house</button>' +
      '<button type="button" class="lc-chipbtn" aria-pressed="false" data-callfor="family">Call my son or daughter — they help me with these things</button>' +
      '<button type="button" class="lc-chipbtn" aria-pressed="false" data-callfor="child">I’m the son or daughter — call me</button>' +
      '</div>' +
      '<p class="lc-callfor-note" id="callfor-note" hidden></p>' +

      '<div class="lc-cta-row">' +
      '<a class="dbp-phone" href="tel:+13235668096">Call us: 323.566.8096</a>' +
      '</div>' +
      '<form class="lc-lead-form" id="lead-form">' +
      '<div class="lc-labeled"><label for="lead-name" id="lead-name-label">Name</label>' +
      '<input id="lead-name" class="dbp-input" type="text" name="name" autocomplete="name" required /></div>' +
      '<div class="lc-labeled"><label for="lead-phone" id="lead-phone-label">Phone number</label>' +
      '<input id="lead-phone" class="dbp-input" type="tel" name="phone" autocomplete="tel" required /></div>' +
      '<button class="dbp-btn dbp-btn--dark dbp-btn--sm" type="submit">Ask for the Honest Read — Free</button>' +
      '</form>' +
      '<p class="lc-lead-fail" id="lead-fail" role="alert" hidden>We couldn’t save your number just now, and we won’t pretend we did. ' +
      'Call us instead: <a href="tel:+13235668096"><strong>323.566.8096</strong></a> — a real person answers, in English or Spanish.</p>' +
      '<p class="lc-microcopy" id="lead-microcopy">Margarita’s team calls you back about this lot — in English or Spanish. ' +
      'If it doesn’t work, we’ll tell you that too. No list, no spam.' +
      (ownerNote ? ' ' + esc(ownerNote) : '') + '</p>' +
      '</div>';

    html +=
      '<p class="lc-result-disclaimer">The Lot Check is a feasibility estimate based on public county records and California state ADU law — ' +
      'not a permit or a zoning determination. Final requirements are set by your city during plan check.</p>';

    html += '</div></div>';

    cardEl.innerHTML = html;
    cardEl.hidden = false;

    wireResultCard(data);
    if (srStatus) {
      srStatus.textContent = 'Result ready: ' + v.title + (data.matchedAddress ? ' for ' + data.matchedAddress : '') + '.';
    }
    resultsSection.scrollIntoView({ behavior: SCROLL, block: 'start' });
    const vt = cardEl.querySelector('.dbp-verdict__title');
    if (vt) vt.focus({ preventScroll: true });
  }

  function wireResultCard(data) {
    // Timeline chips
    const explNote = document.getElementById('exploring-note');
    cardEl.querySelectorAll('[data-timeline]').forEach((btn) => {
      btn.addEventListener('click', function () {
        cardEl.querySelectorAll('[data-timeline]').forEach((b) => { b.classList.remove('lc-chipbtn--on'); b.setAttribute('aria-pressed', 'false'); });
        btn.classList.add('lc-chipbtn--on');
        btn.setAttribute('aria-pressed', 'true');
        qual.timeline = btn.dataset.timeline;
        if (explNote) explNote.hidden = qual.timeline !== 'exploring';
      });
    });

    // Who should we call — switches the form labels (La Herencia pattern)
    const nameLabel = document.getElementById('lead-name-label');
    const phoneLabel = document.getElementById('lead-phone-label');
    const callforNote = document.getElementById('callfor-note');
    cardEl.querySelectorAll('[data-callfor]').forEach((btn) => {
      btn.addEventListener('click', function () {
        cardEl.querySelectorAll('[data-callfor]').forEach((b) => { b.classList.remove('lc-chipbtn--on'); b.setAttribute('aria-pressed', 'false'); });
        btn.classList.add('lc-chipbtn--on');
        btn.setAttribute('aria-pressed', 'true');
        qual.callfor = btn.dataset.callfor;
        if (qual.callfor === 'family') {
          nameLabel.textContent = 'Their name';
          phoneLabel.textContent = 'Their phone number';
          callforNote.textContent = 'We’ll tell them you asked us to look at the lot.';
          callforNote.hidden = false;
        } else if (qual.callfor === 'child') {
          nameLabel.textContent = 'Your name';
          phoneLabel.textContent = 'Your phone number';
          callforNote.textContent = 'Good of you to help. We can talk with you, your parents, or both — in English or Spanish.';
          callforNote.hidden = false;
          if (!qual.owner) { qual.owner = 'helping'; qual.ownerInferred = true; }
        } else {
          nameLabel.textContent = 'Name';
          phoneLabel.textContent = 'Phone number';
          callforNote.hidden = true;
        }
        if (qual.callfor !== 'child' && qual.ownerInferred) { qual.owner = ''; qual.ownerInferred = false; }
      });
    });

    // Lead form — the callback lead. Failure keeps the form and routes to the phone.
    const leadForm = document.getElementById('lead-form');
    const leadFail = document.getElementById('lead-fail');
    if (leadForm) {
      leadForm.addEventListener('submit', function (e) {
        e.preventDefault();
        const btn = leadForm.querySelector('button');
        btn.disabled = true;
        const owner = qual.owner + (qual.callfor === 'family' ? (qual.owner ? '+' : '') + 'call-family' : '');
        submitLead({
          kind: 'callback',
          name: leadForm.name.value.trim(),
          phone: leadForm.phone.value.trim(),
          address: data.matchedAddress || data.inputAddress || '',
          verdict: data.verdict || '',
          goal: qual.goal,
          owner: owner,
          timeline: qual.timeline,
          source: LEAD_SOURCE,
        })
          .then((res) => {
            if (res && res.ok) {
              // Only confirm a callback when the lead was actually captured.
              leadForm.outerHTML =
                '<p class="lc-lead-thanks">Got it. A real person will call you back — English or Spanish. ' +
                'If the honest answer is no, that’s the answer you’ll get. ' +
                'If it’s easier, call us anytime: 323.566.8096.</p>';
              if (leadFail) leadFail.hidden = true;
            } else {
              // Never pretend it was saved — keep the form, show the phone path.
              if (leadFail) leadFail.hidden = false;
              btn.disabled = false;
              btn.textContent = 'Try Again';
            }
          });
      });
    }
  }

  function renderError(message, address) {
    render({
      verdict: 'look',
      inputAddress: address || '',
      headline: message ||
        'We couldn’t read this lot automatically — that happens with unusual records, new addresses, or anything outside Los Angeles and Orange Counties. It doesn’t mean you can’t build.',
      notes: [
        'An automated check is only the first look. A human look is free too — that’s been the first step here since 1991.',
      ],
      nextStep: 'Call us with your address and Margarita’s team will read the lot the way we’ve done it for 35 years — person to person.',
    });
  }

  function runCheck(address) {
    if (checking) return;
    checking = true;
    startLoading();
    track('lot_check_run');

    fetch('/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: address }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok || !body || body.ok === false) {
          throw new Error((body && body.message) || '');
        }
        return body;
      })
      .then((data) => {
        stopLoading();
        data.inputAddress = address;
        render(data);
        track('lot_check_result', { verdict: data.verdict || 'look' });
      })
      .catch((err) => {
        stopLoading();
        renderError(err && err.message ? err.message : '', address);
      })
      .finally(() => {
        checking = false;
      });
  }

  function wireForm(form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const input = form.querySelector('input');
      const address = input.value.trim();
      if (!address) return;
      runCheck(address);
    });
  }

  wireForm(document.getElementById('lotcheck-form'));
  document.querySelectorAll('.lotcheck-form-bottom').forEach(wireForm);

  /* ---------- Analytics: click-to-call on any tel: link (incl. the result card) ---------- */
  document.addEventListener('click', function (e) {
    const tel = e.target.closest && e.target.closest('a[href^="tel:"]');
    if (tel) track('click_to_call', { number: (tel.getAttribute('href') || '').replace('tel:', '') });
  });

  /* ---------- Handbook: email in, download link out. The whole transaction. ---------- */
  const handbookForm = document.getElementById('handbook-form');
  if (handbookForm) {
    handbookForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const btn = handbookForm.querySelector('button');
      btn.disabled = true;
      submitLead({
        kind: 'handbook',
        email: handbookForm.email.value.trim(),
        source: LEAD_SOURCE,
      })
        .then((res) => {
          const note = document.getElementById('handbook-note');
          if (res && res.ok) {
            if (note) note.hidden = true;
            handbookForm.outerHTML =
              '<p class="lc-lead-thanks lc-lead-thanks--center">Your handbook — ' +
              '<a href="/downloads/dbp-adu-handbook.pdf" target="_blank" rel="noopener"><strong>download it here</strong></a>. ' +
              'That was the whole transaction.</p>';
          } else {
            if (note) {
              note.innerHTML = 'That didn’t save just now — call or text <a href="tel:+13235668096"><strong>323.566.8096</strong></a> and we’ll get you the handbook another way.';
              note.classList.add('lc-lead-fail');
            }
            btn.disabled = false;
            btn.textContent = 'Try Again';
          }
        });
    });
  }

  /* ---------- Pro lane: contractors & investors ---------- */
  const proForm = document.getElementById('pro-form');
  if (proForm) {
    let volume = '';
    proForm.querySelectorAll('[data-volume]').forEach((btn) => {
      btn.addEventListener('click', function () {
        proForm.querySelectorAll('[data-volume]').forEach((b) => b.classList.remove('lc-chipbtn--on'));
        btn.classList.add('lc-chipbtn--on');
        volume = btn.dataset.volume;
      });
    });
    proForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const btn = proForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      submitLead({
        kind: 'pro',
        name: proForm.name.value.trim(),
        phone: proForm.phone.value.trim(),
        company: proForm.company.value.trim(),
        goal: volume ? volume + ' projects/yr' : '',
        source: LEAD_SOURCE,
      })
        .then((res) => {
          const note = document.getElementById('pro-note');
          if (res && res.ok) {
            if (note) note.hidden = true;
            proForm.outerHTML =
              '<p class="lc-lead-thanks">Got it — we’ll call you back to talk projects and pricing. ' +
              'If it’s faster, the line is 323.566.8096.</p>';
          } else {
            if (note) {
              note.innerHTML = 'We couldn’t save that just now, and we won’t pretend we did. Call <a href="tel:+13235668096"><strong>323.566.8096</strong></a> and say you build — a real person answers.';
              note.classList.add('lc-lead-fail');
            }
            btn.disabled = false;
            btn.textContent = 'Try Again';
          }
        });
    });
  }
})();
