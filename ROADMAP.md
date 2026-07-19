# Secretary Pro — Feature Roadmap (5 Phases)

A living plan of new capabilities, delivered **one feature at a time** — each fully
wired (backend + API + panel UI), unit-tested, live-verified, documented, and
committed with CI green. Checkboxes are ticked as features ship.

Legend: ⬜ planned · 🔄 in progress · ✅ shipped

---

## Phase 1 — Reply Intelligence
Make the bot understand *what kind* of message it's answering, and answer smarter.

- ✅ 1.1 **Language detection** — detect the incoming message's language; surfaced in the Behavior inspector.
- ✅ 1.2 **Intent classification** — greeting / smalltalk / complaint / feedback / question / request / statement; shown in the inspector.
- ✅ 1.3 **Urgency scoring** — 0–100 from keywords, punctuation and shouting; shown in the inspector.
- ✅ 1.4 **Adaptive reply length** — target length scales to the incoming message's size (setting + prompt-integrated).
- ✅ 1.5 **Quick-reply suggestions** — offline intent-driven candidate replies; clickable in the inspector (drop into composer).
- ✅ 1.6 **Question detector** — flags explicit + implicit questions and whether a reply is expected; shown in the inspector.

**Phase 1 complete** ✅ — all six reply-intelligence signals ship in the Behavior inspector.

## Phase 2 — Contact & Relationship CRM
Turn the contacts list into a lightweight CRM.

- ✅ 2.1 **Interaction stats** — per-contact volumes, response rate, cadence, first/last seen; shown atop the contact editor.
- ✅ 2.2 **Dominant topics** — recurring, stopword-filtered keywords from a contact's history; shown as chips in the editor.
- ✅ 2.3 **Relationship strength** — 0–100 (cool/warm/strong) from volume, recency and reciprocity; tile in the editor.
- ✅ 2.4 **Contact timeline** — per-day activity digest (in/out counts + snippet, last 30 days) with a Timeline button in the editor.
- ✅ 2.5 **Important dates** — per-contact birthdays/anniversaries with age math; upcoming feed + daily-summary heads-up.
- ✅ 2.6 **Duplicate detector** — same-username / same-normalized-name pairs, one click from the Contacts toolbar.

**Phase 2 complete** ✅ — the Contacts tab is a lightweight CRM: stats, topics, strength, timeline, dates, dupes.

## Phase 3 — Analytics & Insights
Deeper, actionable numbers on the Dashboard/Monitoring.

- ✅ 3.1 **Intent breakdown** — intent distribution bars beside the mood mix in Monitoring.
- ✅ 3.2 **Activity heatmap** — 7×24 weekday×hour grid in Monitoring, intensity-scaled, 30-day window.
- ✅ 3.3 **Response-time distribution** — p50/p90/p99 + 5-bucket histogram in Monitoring.
- ⬜ 3.4 **Language distribution** — which languages people write in.
- ⬜ 3.5 **Cost forecast** — projected monthly spend from the current trend.
- ⬜ 3.6 **Weekly digest** — a richer weekly summary (export + optional send).

## Phase 4 — Panel UX & Productivity
Make the panel faster and more pleasant to operate.

- ⬜ 4.1 **Global search** — one box searching contacts, logs and settings.
- ⬜ 4.2 **Shortcuts help** — a `?` overlay listing every keyboard shortcut.
- ⬜ 4.3 **Settings filter** — live-filter the ~100 settings by keyword.
- ⬜ 4.4 **Notification center** — a history of recent toasts/alerts.
- ⬜ 4.5 **Snippet quick-insert** — drop saved snippets into the composer/prompt.
- ⬜ 4.6 **Density toggle** — comfortable/compact layout preference.

## Phase 5 — Reliability, Safety & Extensibility
Harden the edges and make it easy to extend.

- ⬜ 5.1 **PII scanner** — detect emails/phones/cards/IBANs in outgoing text with a policy.
- ⬜ 5.2 **Per-provider circuit breaker** — trip a provider after repeated failures, auto-recover.
- ⬜ 5.3 **Config validate & export** — a one-click config sanity report + portable export.
- ⬜ 5.4 **Self-test endpoint** — an end-to-end readiness probe beyond `/health`.
- ⬜ 5.5 **Error taxonomy** — classify logged errors into actionable categories.
- ⬜ 5.6 **Webhook signing** — optionally HMAC-sign outbound alert webhooks.

---

**Delivery rule:** ship the smallest complete slice that a user can see and use, then
move to the next line. No dead toggles, no half-built UI. Every shipped item updates
its checkbox here and gets a line in README/DOCS.
