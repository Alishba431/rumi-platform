# 👋 Teacher Nudges

> A short, friendly check-in for a teacher who has gone quiet, sent once, on the channel they last used.

## What it is

Teachers often stop writing in for a day or two. They are busy, not lost. A light check-in brings many of them
back: *"Hi Sam 👋 — it has been a little while. Planning anything for your next class? Tell me the topic and I
can draft a lesson plan, or ask me anything about your teaching."* The teacher answers in their own words, and
the answer goes to the normal chat. No buttons or menus are involved.

Under that one message sits a small, generic system for **scheduled, proactive messages** ("nudges"). It has
one table, one sweeper, and a registry of nudge *kinds*. This release ships one kind, `re_engage`. Adding
another kind is a single module (see [Add a nudge kind](#add-a-nudge-kind)).

## Why it is built this way

Scheduled messaging has one failure that matters: **the same teacher gets the same message twice.** Two worker
replicas can tick in the same second, and a deploy can kill a send halfway through. Every design choice below
exists so that this cannot happen, and so that every "why didn't they get it?" has an answer in the database.

## How it works

1. **One table.** `teacher_nudges` has one row per teacher, per local day, per kind:
   `UNIQUE (user_id, nudge_date, kind)`. A row moves from `pending` to `sending`, and then to `sent`,
   `skipped` (with a `skip_reason`) or `failed`. Only `bot/shared/services/nudges/teacher-nudges.store.js`
   reads or writes this table.
2. **A sweep runs every few minutes.** Each tick, the sweep does four things in order:
   - It reclaims rows stuck in `sending` for more than 10 minutes and marks them `failed`. They are not
     retried, because the message may already have gone out.
   - It runs each kind's `prepare` to book today's cohort.
   - It claims the rows that are due, up to `TEACHER_NUDGES_MAX_PER_TICK` across all kinds.
   - It hands each claimed row to that kind's `handle` and records the outcome.

   Each tick writes one summary log line (`teacher_nudges sweep: done`) with its counts.
3. **Booking is idempotent.** Booking is a plain INSERT, and the database's UNIQUE constraint does the work.
   If a row already exists, the database answers `23505`, which the store reads as "already booked". Five
   replicas building the same cohort produce one row.
4. **Sending is single-flight.** supabase-js cannot run `UPDATE … LIMIT`, so the claim happens in two steps:

   ```js
   // 1. pick candidates
   select id from teacher_nudges where kind = $kind and status = 'pending' and scheduled_at <= now
     order by scheduled_at limit $n
   // 2. claim them — the status guard is ON the update
   update teacher_nudges set status = 'sending', claimed_at = now
     where id in ($ids) and status = 'pending'
     returning *
   ```

   A sweeper only sends the rows its **own** UPDATE returned. If two replicas pick the same candidates, each
   one wins a disjoint set, and the loser gets an empty list. If the `status = 'pending'` guard were dropped,
   two replicas would both send.
5. **Handlers never write their own rows.** A kind's `handle` returns `{ sent: true }` or
   `{ skipped: '<reason>' }`, and the sweeper records it. If `handle` throws, or returns anything else, the row
   is marked `failed` and the error message is stored in `context.error`. A send that returns `false` also
   counts as failed, never as sent.

### The `re_engage` kind

The `re_engage` kind handles booking and sending as follows.

- **Who gets booked:** registered teachers who meet both of these conditions:
  - Their last message, on any channel, is older than `TEACHER_NUDGES_QUIET_MINUTES` (default 20 hours).
  - That last message is newer than `TEACHER_NUDGES_LOOKBACK_DAYS` (default 14 days), so someone who left
    months ago is not messaged out of the blue.

  WhatsApp activity comes from `users.last_message_at`. Slack and Discord activity comes from
  `user_channels.last_message_at`.
- **Once per quiet spell:** each row records the `last_message_at` it is about. A teacher is not booked again
  while a `sent` row exists for that same value. As long as they stay silent, they get one check-in, however
  long the silence lasts. When they write in, a new spell starts, and the next silence can be nudged.
- **Where it goes:** the message goes to the channel the teacher used most recently, among the channels this
  deployment runs. The address is formatted as the messaging facade's identifier: a bare phone number for
  WhatsApp, or `slack:<id>` / `discord:<id>`. If the teacher has no channel row, `users.phone_number` is used.
  The message is sent with the facade's `sendMessage`.
- **Checks at send time:** a row can wait a tick before it is sent, so everything is checked again when it is
  sent. Any failed check skips the row:

  | Check | Skip reason |
  |---|---|
  | The teacher is still registered | `not_eligible` |
  | The teacher is still silent | `active_again` |
  | It is not quiet hours | `quiet_hours` |
  | There is an address to send to | `no_address` |

### The Meta 24-hour rule

On the **Meta WhatsApp Cloud API** (`CHANNEL_DRIVER=meta`), a business may only send free-form messages
within 24 hours of the person's last message. This is the customer-service window. After that, only
pre-approved templates are allowed. This kind sends **no template**. On the Meta driver, it sends only while
the window is open, which is between 20 and 24 hours of silence with the defaults. Outside the window the row
is skipped with `window_closed`. Like a send, that skip counts as "this spell is handled", so the teacher is
not booked again every day.

Baileys, Slack and Discord have no such window, so the rule applies only to the Meta driver. Which driver a
message uses is decided by `resolveChannelDriver` and the identifier's prefix (`driverForIdentifier`), the same
way the messaging facade routes it.

### Quiet hours

Nothing is booked during quiet hours (`TEACHER_NUDGES_QUIET_HOURS`, local time in `TEACHER_NUDGES_TZ`). A row
that is reached during quiet hours anyway, for example booked at 20:59 and claimed at 21:01, is **skipped**
with `quiet_hours`, not deferred. If the teacher is still quiet, they are booked again on a later local day.
Deferring the row instead could let it and the next day's row both send in the same tick.

## What the teacher experiences

One short, warm message, after roughly a day of silence and never in the middle of the night. If they reply,
it is a normal conversation. If they don't, they hear nothing more until they have written in and gone quiet
again.

## Enable it

1. Apply the schema. Fresh installs already have the `teacher_nudges` table in
   `infrastructure/supabase/00_complete-schema.sql`. Existing installs run the additive migration
   `infrastructure/supabase/migrations/V2.5.1__teacher_nudges.sql` with
   `node infrastructure/scripts/migrate.js` (see [pulling updates](../pulling-updates.md)).
2. Set `TEACHER_NUDGES_ENABLED=true` and restart the SQS worker (`bot/workers/sqs-worker.js`). The first sweep
   runs 90 seconds after boot, then every `TEACHER_NUDGES_SWEEP_MINUTES`.
3. **Or** skip the in-process interval and schedule the one-shot entry from cron:
   `node bot/workers/teacher-nudges.worker.js`. Running both is harmless, because the claim is
   single-flight.

To switch nudges off, unset the flag or set it to anything other than `true`, `1` or `yes`. You can also pause
them without touching the flag with the operator feature switch `RUMI_FEATURE_TEACHER_NUDGES=off`. The next tick
does nothing and does not even read the database.

| Variable | Default | What |
|---|---|---|
| `TEACHER_NUDGES_ENABLED` | _(off)_ | Master switch. `true`, `1` or `yes` turns it on. Read on every tick. |
| `TEACHER_NUDGES_SWEEP_MINUTES` | `5` | Minutes between sweeps on the SQS worker. Fractions are allowed (`0.5` means every 30 s). Values below `0.1` are ignored. |
| `TEACHER_NUDGES_MAX_PER_TICK` | `200` | The most rows one sweep claims, across every kind. A backlog drains over the following ticks. |
| `TEACHER_NUDGES_TZ` | `ATTENDANCE_TZ`, else `UTC` | IANA time zone used for "one per local day" and quiet hours. Blank uses the school's attendance clock. Daylight saving is handled. |
| `TEACHER_NUDGES_QUIET_HOURS` | `21-7` | Local hours with no nudges, written `start-end` (end exclusive). The range may wrap midnight. Blank means no quiet hours. |
| `TEACHER_NUDGES_QUIET_MINUTES` | `1200` | How long a teacher must be silent before `re_engage` books them. |
| `TEACHER_NUDGES_LOOKBACK_DAYS` | `14` | Silences that began longer ago than this are left alone. |

To see what happened, query the table:

```sql
select kind, status, skip_reason, count(*)
from teacher_nudges
where nudge_date > current_date - 7
group by 1, 2, 3
order by 1, 2, 3;
```

## Add a nudge kind

A kind is one module, `bot/shared/services/nudges/<name>.kind.js`, with this shape:

```js
module.exports = {
  kind: 'lesson_follow_up',            // lower_snake_case; stored in teacher_nudges.kind
  async prepare(now) {                 // optional: book today's cohort, return how many were booked
    // ...pick teachers, then for each one:
    await store.book({ userId, kind: 'lesson_follow_up', nudgeDate: localDate(now), scheduledAt: now, context: {} });
    return booked;
  },
  async handle(row, { now }) {         // required: one claimed row
    // check, then send through the facade: require('../whatsapp.service').sendMessage(to, text)
    return { sent: true, context: { channel } };   // or { skipped: 'window_closed' }
  },
};
```

Then:

1. Add it to `KINDS` in `bot/shared/services/nudges/kinds.js`. Both schedulers register kinds from that list.
2. If it needs a new skip reason, add the reason to `SKIP_REASONS` in `teacher-nudges.store.js`. The list is
   closed on purpose: an unknown reason marks the row `failed`.
3. No migration is needed. `kind` is free text, because the code registry is the source of truth.

Some rules for a new kind:

- `prepare` runs on every tick on every replica, so it must be idempotent and cheap.
- `handle` should check eligibility again at send time.
- On the Meta driver, check the 24-hour window the way `re-engage.kind.js` does.
- Use `addressForUser` (`nudges/address.js`) to pick where the message goes.
