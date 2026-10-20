# 📝 Lesson Quiz — a quiz from the lesson

> A teacher has no time to write homework and no time to mark forty copies of it. The lesson quiz does both
> jobs. It writes a quiz on the lesson just taught (from the coaching recording) or just planned (from a
> Rumi lesson plan), plus a one-page PDF that explains every question to the teacher. The teacher forwards one
> message to the class, each child answers in their own chat and gets a reason after every answer, and the
> next morning the teacher gets a class report saying what to reteach.

## In programme terms

**A quick check on the lesson just taught, with what to reteach tomorrow.**

Assessment is formative when its evidence is used to adapt teaching [Black-Wiliam98]. RTI recommends that guides "embed in each lesson checks for understanding" [Piper-RTI18]. This release turns the lesson just taught into a short quiz. The quiz can come from the coaching recording, from the teacher's lesson plan, or from any topic. A second model checks the answer key without seeing it first. The teacher receives a one-page explanation of each question and one message to forward to the class. Each child answers in their own chat and gets a reason after every answer, plus a score card. If few children have started, there is one reminder, never in quiet hours. Next morning the teacher gets a class report with a "For tomorrow" box that says what to reteach. This closes the loop that matters most in formative assessment: the evidence returns to the teacher in time to act on it.

**Where it sits in a structured-pedagogy programme:** teacher guide → delivery → coaching → **assessment (formative)** → back into the next lesson.

### Honest limits

- **Tested end to end on the owned messenger** with real models: 11 of 12 scenarios pass. The one failure: in 8 real quizzes the default model never wrote a "select all that apply" question (typed multi-select answers do score correctly).
- **A second model checks the answer key, but fails open.** If that check cannot run, the quiz is still sent and is recorded as unverified.
- **Children's accounts.** On the owned messenger, each child needs an account; on WhatsApp a link is enough.
- **Not a standardised measure.** The class report is a classroom signal for tomorrow's lesson, not M&E data.
- **Typing rules.** During a lesson quiz only letters count as answers; any other text gets an ordinary chat reply.

### Sources

- [Black-Wiliam98] Black, P., & Wiliam, D., 1998, "Inside the black box: Raising standards through classroom assessment", *Phi Delta Kappan* 80(2):139–148.
- [Piper-RTI18] Piper, B., Sitabkhan, Y., Mejía, J., & Betts, K., 2018, *Effectiveness of Teachers' Guides in the Global South: Scripting, Learning Outcomes, and Classroom Utilization*, RTI Press OP-0053-1805. https://doi.org/10.3768/rtipress.2018.op.0053.1805

## What it is

A few minutes after a coaching report arrives, Rumi asks once: *"Want a quiz on the lesson you just taught?"*.
The teacher says yes and, where the deployment offers more than one quiz language, picks the quiz language.
About a minute later they receive two things:

1. **A PDF for the teacher only.** It lists the lesson objectives the quiz checks, then every question
   with why it was asked and what each wrong answer reveals.
2. **One forwardable message** for the class group. Its join line follows the teacher's channel: a `wa.me`
   link on WhatsApp, a `matrix.to` link to the bot plus a join code on Matrix, and the code alone elsewhere.
   On any channel a child can also type `join <CODE>` or `QUIZ-<CODE>`.

Each child joins, gives their name and class, and answers the questions one at a time. They get an
immediate reason after each answer and a score card with their name at the end. If fewer than five children
have started after six hours, the teacher gets one nudge (never during the school's quiet hours, and never
twice). The next morning, or earlier once the class has finished, the teacher gets a **class report PDF**
showing who got what, which question most children missed, and a *For tomorrow* reteach box.

`/quiz` is the lesson-quiz menu: every recent lesson and lesson plan with its quiz state (*no quiz yet*,
*being made*, *sent · N started*, *report sent*), *Quiz on any topic*, *Video quizzes*, and the classic
*Quiz to parents' phones*. On channels without native lists the menu is a numbered list.

## How it works

| Step | Code |
|---|---|
| Coaching report delivered → offer queued (+4 min). This suppresses the classic Trigger-3 quiz offer. | `services/coaching/report-generator.service.js` `scheduleTranscriptQuiz` → `quiz/transcript-quiz-offer.service.js` |
| `/quiz`, bare `quiz`, `/quiz <topic>` | `handlers/text-message.handler.js` → `quiz/quiz-menu-entry.service.js`, `quiz/transcript-quiz-list.service.js`, `quiz/providers/{lp-generated,topic}.provider.js` |
| Lesson source: coaching transcript, Rumi lesson plan, or a topic | `quiz/quiz-sources.js`, `quiz/transcript-quiz-generate.service.js` `resolveLessonSource` |
| Digest → author → validate → blind key check → rows → figures → PDF | `quiz/transcript-quiz-{digest,author,validator,key-verify,rows,figure}*.js`, `quiz/plan-quiz-digest.service.js`, `templates/transcript-quiz-teacher.template.js` |
| Hand-off: PDF + forwardable message + report promise; nudge scheduled | `quiz/transcript-quiz-handoff.service.js`, `quiz/transcript-quiz-nudge.service.js` |
| Child joins by link or code; typed answers (`B`, `b.`, `A C` for select-all, `STOP`) | `quiz/video-quiz-share.service.js` (`joinInvite`, `parseShareCode`), `quiz/video-quiz.service.js` (`answerTypedLetter`, `stopTyped`) |
| Class report next morning (school time), guidance box from the model | `quiz/video-quiz-report.service.js`, `templates/video-quiz-report.template.js` |
| Jobs | `workers/sqs-worker.js`: `quiz_offer`, `quiz_generate`, `quiz_nudge_teacher`, `quiz_child_videos_offer` |

Lesson plans: when Rumi delivers a lesson-plan PDF, the worker extracts its text into
`lesson_plans.content.plan_text`, so a plan quiz is written from what was actually planned. A plan quiz's PDF
says *What you planned* and a topic quiz says what topic it covers. Neither ever says *what you taught*.

Answer keys are checked by a second model that solves each question blind. If that model is unreachable, or
answers nothing, the quiz still goes out and the row records it as unverified (`meta.key_verify`).

**Children's answers.** Typed answers (`A`, `b.`, `2`, `۲`, `A C`) are read only during a lesson quiz
(transcript, lesson plan or topic). A v1.2.0 video quiz is still answered by taps, and other text during it goes
to chat as before. Anything that is not a letter, number or letter set goes to chat. `STOP` ends a lesson quiz.
Reports count each child's **first** completed attempt, so a retake after seeing the reasons does not replace
it. On Slack, Discord and Matrix a child is identified by their full channel id, on phone channels by their
number. A friend who joins through a child's invite is counted in the teacher's report.

**Share codes.** Codes are drawn from a cryptographic random source. A sender who sends 5 wrong or expired codes
within 10 minutes gets no reply to further codes until the window has passed (this needs Redis; without Redis
there is no limit). With video quizzes off for the region, a video quiz's code goes to ordinary chat as in
v1.2.0; a lesson quiz's code still joins. Each class report goes to the chat its class link was sent to.

**Class cards** (`CLASS_CARD_ENABLED`). Each child's card shows the top five children by first name, the rest
as a count, and the child's own row. Family names never appear.

**Rendering.** Figures, question cards, the teacher PDF, the class report and the cards are rendered by headless
Chromium with JavaScript off and no network apart from `data:` and `about:` (`htmlToPdf`/`htmlToImage` with
`{ untrusted: true }`: the browser context is offline, behind a proxy nothing listens on, and aborts every other
request, so not even a prefetch or an iframe leaves the machine). Every model-written or child-typed text is escaped, and figure colours are limited to the
engine's tokens and hex values. If you customise these templates, inline every asset as a `data:` URI. The
diagram engine and its third-party parts are listed in [`bot/vendor/lp-v9/README.md`](../../bot/vendor/lp-v9/README.md).

## Children on Matrix

Setting up the Matrix channel itself is covered in [`docs/channels/matrix.md`](../channels/matrix.md); the share
link also needs `MATRIX_USER_ID` (the bot's account).

On a Matrix deployment every child needs an account on the school's homeserver. **The school's admin creates
these accounts**, as the Rumi Messenger guides describe. Children are not expected to self-register. The child
opens the `matrix.to` link (or starts a chat with the bot) and sends the code from the teacher's message.

## Enable it

```bash
TRANSCRIPT_QUIZ_ENABLED=true          # the lesson quiz, its offer and the /quiz menu
SCHOOL_TIMEZONE=UTC                   # IANA zone name: report time, quiet hours, "today" for the daily cap
QUIZ_LANGUAGES=en                     # e.g. en,ur — more than one makes Rumi ask the quiz language
SQS_QUIZ_QUEUE_URL=                   # a Standard SQS queue (or run QUEUE_DRIVER=bullmq)
```

The quiz is made by the worker (the `worker` process in `bot/Procfile`, `node workers/sqs-worker.js`), so it
must be running. Its delayed jobs (the offer after the report, the nudge, the class report) need a queue that
honours delays: set `SQS_QUIZ_QUEUE_URL` to a Standard SQS queue, or run `QUEUE_DRIVER=bullmq`. On the FIFO main
queue alone, the offer arrives at once and the nudge is skipped.

With only `OPENROUTER_API_KEY` set, the default models run on OpenRouter: `TRANSCRIPT_QUIZ_MODEL` (author),
`TRANSCRIPT_QUIZ_VERIFY_MODEL` (blind key check) and `QUIZ_REPORT_MODEL` (the reteach box), each defaulting to
its job in the model registry (`bot/shared/config/model-registry.js`). Under `LLM_PROVIDER=openai` (with
`OPENAI_API_KEY`) every quiz job uses its OpenAI default (`quiz.transcript` → `gpt-4.1-mini`). To build share
links, set `WHATSAPP_BOT_NUMBER` on WhatsApp and `MATRIX_USER_ID` on Matrix. Without either, the message carries
the join code and the bot's name. Every variable, with its default, is in the *Lesson quiz* block of
[`.env.template`](../../.env.template).

With `TRANSCRIPT_QUIZ_ENABLED` unset, `/quiz` is the classic quiz exactly as before, and video quizzes are
unchanged. `RUMI_FEATURE_LESSON_QUIZ=off` (the console switch) also stops lesson-quiz buttons and quizzes already
queued: they exit quietly, and `/quiz` can make them again once it is back on.

**Storage.** Question cards and figures are uploaded to object storage (R2) when `R2_*` is set. Without it they
are kept on local disk under `bot/temp/transcript_quizzes/` and sent from there. That works on Baileys, Slack,
Discord and Matrix when the worker and the bot run on the same host. The Meta Cloud API cannot fetch a local
file, so on `CHANNEL_DRIVER=meta`, or with the worker and the bot on separate machines, set `R2_*`. Nothing
clears that folder yet; prune it with your usual temp-file job.

**Teacher-side behaviour.** With more than three `QUIZ_LANGUAGES` the language ask is a list; a channel that
refuses it gets numbered text, and the teacher's typed number (or the language's name) answers it. If the offer
job decides not to offer (low confidence, too few objectives, a subject filter), the coaching report's usual
quiz-to-parents ask and next-feature suggestion are sent then. A quiz stuck in *being made* for
`TRANSCRIPT_QUIZ_STALE_MINUTES` (default 30) can be made again.

**Languages.** English copy ships for every deployment. An `ur` pack (copy, Nastaliq PDFs, Urdu validator
rules) is included. A quiz language with no catalogue falls back to English copy, and the model still writes the
questions in the chosen language.

## Data

`quizzes` gains `coaching_session_id`, `language` and `meta jsonb`, the statuses `offered | declined |
skipped`, and one-quiz-per-lesson unique indexes for transcript and lesson-plan quizzes. The schema is in
`infrastructure/supabase/00_complete-schema.sql` and the upgrade is
`infrastructure/supabase/migrations/V2.9.0__lesson_quiz.sql` (additive). Children's answers use the same tables
as video quizzes: `quiz_share_codes` (one code per class link), `quiz_sessions` (one per child) and `quiz_answers`.
`quiz_share_codes` gains `teacher_to` (nullable): the chat each class link was sent to, where that code's class
report goes. Existing codes keep going to the teacher's WhatsApp number.

The migration is all-or-nothing and safe to re-run. If it prints `NOTICE: quizzes_one_lesson_plan_quiz not
created`, keep one `lp_generated` quiz per lesson plan and run it again.

## Not in this release

The afternoon "quiz on today's lesson plan" offer (it needs a nudges sweeper), Meta Flow front-ends for the
menu and the multi-select picker (every surface works without them), an intro film on the offer, and
training quizzes.
