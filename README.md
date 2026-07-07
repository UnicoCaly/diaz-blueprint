# DBP Lot Check

Free ADU feasibility checker for Diaz Blueprint & Drafting Services — diazblueprint.com.
A homeowner enters their address; the tool reads public county parcel records, applies
California state ADU law, and returns a hedged verdict ("Likely Buildable" / "Likely
Buildable — with conditions" / "Needs a Closer Look") with types, sizes, and ballpark costs.

**Stack:** static HTML/CSS/JS + Cloudflare Pages Functions. No build step, no framework,
no paid APIs, no API keys.

```
public/            the landing page (index.html, styles.css, app.js)
functions/api/     serverless endpoints — check.js (feasibility), lead.js (callbacks)
shared/rules.js    the ADU rules engine (pure functions, unit-testable)
shared/geocode.js  address -> coordinates + county (US Census geocoder, no key)
shared/parcels.js  lon/lat -> parcel facts (LA Assessor + OC OCPW, no key)
test/              node --test unit tests for the rules engine
schema.sql         D1 table for leads
package.json       type:module + the test/dev/deploy scripts
```

### How /api/check works
`address` → `shared/geocode.js` (US Census) → `shared/parcels.js` (LA Assessor for
Los Angeles County, OC OCPW for Orange County) → `shared/rules.js` (CA statewide ADU
law, Gov. Code §§66310–66342) → a hedged result card. LA records carry real use codes
(high-confidence verdicts); OC publishes less, so OC lots are hedged to "with
conditions." Anything outside LA/OC, or any lookup that fails, falls through to
"Needs a Closer Look" with the phone path — never an error, never a definitive answer.

## Run locally

```bash
npx wrangler pages dev
# → http://localhost:8788
```

The feasibility check calls live public APIs (US Census geocoder, LA County Assessor,
OC GIS), so local dev needs internet access.

## Test the rules engine

```bash
node --test test/
```

## Deploy (Cloudflare Pages)

```bash
npx wrangler pages deploy
```

Or connect the folder to a Pages project in the Cloudflare dashboard. Suggested route:
`diazblueprint.com/lot-check` or `lotcheck.diazblueprint.com`.

### Lead capture (set up at least one before launch)

Callback requests from the result card POST to `/api/lead`. A lead is captured two
ways, for redundancy, so one never silently disappears:

1. **D1 storage** — the durable record.
   ```bash
   npx wrangler d1 create dbp-lotcheck-leads
   # paste the printed [[d1_databases]] binding into wrangler.toml (template is there)
   npx wrangler d1 execute dbp-lotcheck-leads --remote --file=./schema.sql
   ```
2. **Real-time alert** — what actually pages a human. Set a Slack / Zapier / Make /
   Discord incoming webhook (Zapier can relay to SMS or email):
   ```bash
   npx wrangler pages secret put LEAD_WEBHOOK_URL
   ```

`/api/lead` returns `ok:true` only when the lead was actually stored or alerted. If
neither is configured, the page tells the visitor to call rather than falsely
confirming a callback. **Set up at least one before launch** — ideally both.

Read leads anytime:

```bash
npx wrangler d1 execute dbp-lotcheck-leads --remote \
  --command "SELECT created_at, name, phone, address, verdict, source FROM leads ORDER BY id DESC LIMIT 50"
```

## Honesty guardrails (do not remove)

- Results are always **"likely"** — the engine never issues a definitive yes or no.
  An automated check cannot see easements, fire zones, coastal overlays, HOA rules,
  or a city's mood at the counter. The copy and the legal footer say so.
- Commercial/unknown/odd parcels fall through to **"Needs a Closer Look"** + call CTA,
  never an error page. Every failure mode ends at the phone number: 323.566.8096.
- The plan-set price (from $4,800, priced by project) stays on the page (qualification by transparency).

— Prepared by Proágo for Diaz Blueprint & Drafting Services, June 2026.
