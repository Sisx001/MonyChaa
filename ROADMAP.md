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
- ⬜ 1.3 **Urgency scoring** — 0–100 urgency from keywords, punctuation, time-sensitivity.
- ⬜ 1.4 **Adaptive reply length** — auto-scale target length to the incoming message's size/complexity.
- ⬜ 1.5 **Quick-reply suggestions** — offline candidate replies for a message (panel + future Telegram).
- ⬜ 1.6 **Question detector** — flag when a message actually asks something needing an answer.

## Phase 2 — Contact & Relationship CRM
Turn the contacts list into a lightweight CRM.

- ⬜ 2.1 **Interaction stats** — per-contact message counts, first/last seen, response rate.
- ⬜ 2.2 **Dominant topics** — keyword-topic extraction from a contact's history.
- ⬜ 2.3 **Relationship strength** — a 0–100 score from frequency, recency and reciprocity.
- ⬜ 2.4 **Contact timeline** — a compact recent-activity timeline endpoint + panel view.
- ⬜ 2.5 **Important dates** — remember birthdays/anniversaries per contact, surface upcoming ones.
- ⬜ 2.6 **Duplicate detector** — find likely-duplicate contacts to merge.

## Phase 3 — Analytics & Insights
Deeper, actionable numbers on the Dashboard/Monitoring.

- ⬜ 3.1 **Intent breakdown** — distribution of intents across recent messages.
- ⬜ 3.2 **Activity heatmap** — busiest weekday×hour grid.
- ⬜ 3.3 **Response-time distribution** — p50/p90/p99 buckets.
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
