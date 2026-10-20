/**
 * Stale Session Worker
 * Coaching Stuck Sessions - Railway Cron Service
 *
 * Runs every 15 minutes via Railway Cron
 *
 * Currently handles:
 * - Coaching sessions stuck in 'conducting_conversation' status
 * - Observe: teacher reports waiting on an invite tap (untapped sweep) and
 *   finished observations whose report was never sent (undelivered sweep)
 *
 * Timeline for Coaching:
 * - 0h: User last interacted
 * - 2h: Send reminder (if idle)
 * - 12h: Auto-generate partial report (if still no response)
 *
 * Future extensibility:
 * - Reading assessments (stuck in awaiting_audio)
 * - Lesson plan generation (stuck in processing)
 * - Any other multi-step flows
 *
 * Created: November 30, 2025
 */

require('dotenv').config();
const supabase = require('../shared/config/supabase');
const { logToFile } = require('../shared/utils/logger');
const { displayName } = require('../shared/utils/display-name');
const WhatsAppService = require('../shared/services/whatsapp.service');
const CoachingJobQueueService = require('../shared/services/coaching/coaching-job-queue.service');
const { ownCoaching } = require('../shared/services/coaching/own-coaching');

// Coaching thresholds (in milliseconds)
const COACHING_REMINDER_THRESHOLD_MS = 2 * 60 * 60 * 1000;  // 2 hours
const COACHING_AUTO_COMPLETE_THRESHOLD_MS = 12 * 60 * 60 * 1000;  // 12 hours
const USER_ACTIVE_THRESHOLD_MS = 5 * 60 * 1000;  // 5 minutes = user considered active

// Future: Reading assessment thresholds
// const READING_REMINDER_THRESHOLD_MS = 1 * 60 * 60 * 1000;  // 1 hour
// const READING_CANCEL_THRESHOLD_MS = 24 * 60 * 60 * 1000;   // 24 hours

/**
 * Main entry point - called by Railway Cron
 */
async function main() {
  const startTime = Date.now();
  console.log('============================================');
  console.log('🕐 Stale session worker started:', new Date().toISOString());
  console.log('============================================');

  try {
    // The teacher-activity check reads coaching_sessions.observation_type when it exists (own-coaching.js).
    await require('../shared/services/coaching/own-coaching').probe();

    // Process coaching sessions
    const coachingResults = await processStaleCoachingSessions();
    console.log('📊 Coaching results:', coachingResults);

    // Observe delivery sweeps. Each is independent and never fails the run.
    for (const [label, sweep] of [['untapped', runUntappedSweep], ['undelivered', runUndeliveredSweep]]) {
      try {
        console.log(`📊 Observe ${label} sweep:`, await sweep());
      } catch (err) {
        logToFile(`❌ Observe ${label} sweep failed`, { error: err.message });
      }
    }

    // Future: Process reading assessments
    // const readingResults = await processStaleReadingAssessments();
    // console.log('📊 Reading results:', readingResults);

    const duration = Date.now() - startTime;
    console.log(`✅ Worker completed in ${duration}ms`);
    console.log('============================================');
    process.exit(0);
  } catch (error) {
    console.error('❌ Worker error:', error);
    logToFile('❌ Stale session worker error', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

/**
 * Process coaching sessions in 'conducting_conversation' status
 * @returns {Promise<object>} Results summary
 */
async function processStaleCoachingSessions() {
  const now = Date.now();
  let reminders = 0;
  let autoCompleted = 0;
  let skipped = 0;

  // Query sessions in conducting_conversation status. recipient_identifier
  // (not users.phone_number) is the channel this session actually
  // originated on — a WhatsApp-only join would misdeliver (or silently drop)
  // a reminder for a Slack-originated session. See
  // coaching-session.service.js#initiateSession, which stores it.
  const { data: staleSessions, error } = await supabase
    .from('coaching_sessions')
    .select(`
      id, user_id, status, conversation_state,
      transcript_text, analysis_data, lesson_plan_text,
      reminder_sent_at, created_at, recipient_identifier,
      users!inner(first_name)
    `)
    .eq('status', 'conducting_conversation')
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to query stale sessions: ${error.message}`);
  }

  console.log(`📋 Found ${staleSessions?.length || 0} sessions in conducting_conversation`);

  for (const session of staleSessions || []) {
    // Get last interaction time from conversation_state
    const lastInteraction = session.conversation_state?.last_interaction
      ? new Date(session.conversation_state.last_interaction).getTime()
      : new Date(session.created_at).getTime();

    const idleTime = now - lastInteraction;
    const idleHours = (idleTime / (1000 * 60 * 60)).toFixed(1);

    console.log(`  → Session ${session.id.substring(0, 8)}... idle for ${idleHours}h`);

    // Check if user is currently active (don't interrupt)
    const isUserBusy = await checkUserActivity(session.user_id);
    if (isUserBusy) {
      console.log(`    ⏳ User active, skipping`);
      skipped++;
      continue;
    }

    // Phase 2: Auto-complete (12h threshold)
    if (idleTime >= COACHING_AUTO_COMPLETE_THRESHOLD_MS) {
      console.log(`    🔄 Auto-completing (${idleHours}h > 12h threshold)`);
      await autoCompleteSession(session);
      autoCompleted++;
      continue;
    }

    // Phase 1: Send reminder (2h threshold, not already sent)
    if (idleTime >= COACHING_REMINDER_THRESHOLD_MS && !session.reminder_sent_at) {
      console.log(`    📨 Sending reminder (${idleHours}h > 2h threshold)`);
      await sendSessionReminder(session);
      reminders++;
    }
  }

  return { total: staleSessions?.length || 0, reminders, autoCompleted, skipped };
}

/**
 * Check if user is currently active (don't interrupt them)
 * @param {string} userId - User UUID
 * @returns {Promise<boolean>} True if user is active
 */
async function checkUserActivity(userId) {
  const now = Date.now();

  // Check 1: Recent conversation activity
  const { data: recentConversation } = await supabase
    .from('conversations')
    .select('updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();

  if (recentConversation) {
    const lastActivity = new Date(recentConversation.updated_at).getTime();
    if (now - lastActivity < USER_ACTIVE_THRESHOLD_MS) {
      logToFile('User has recent conversation activity', {
        userId,
        lastActivity: recentConversation.updated_at
      });
      return true;
    }
  }

  // Check 2: Active reading assessment in progress
  const { data: activeReading } = await supabase
    .from('reading_assessments')
    .select('id, status')
    .eq('user_id', userId)
    .in('status', ['awaiting_audio', 'transcribing', 'analyzing'])
    .limit(1)
    .single();

  if (activeReading) {
    logToFile('User has active reading assessment', {
      userId,
      assessmentId: activeReading.id,
      status: activeReading.status
    });
    return true;
  }

  // Check 3: Another coaching session in active state
  const { data: activeCoaching } = await ownCoaching(supabase
    .from('coaching_sessions')
    .select('id, status')
    .eq('user_id', userId)) // never a coach's observation of this teacher: it is not their own session
    .in('status', ['transcribing', 'analyzing', 'awaiting_lesson_plan', 'generating_report'])
    .limit(1)
    .single();

  if (activeCoaching) {
    logToFile('User has another active coaching session', {
      userId,
      sessionId: activeCoaching.id,
      status: activeCoaching.status
    });
    return true;
  }

  return false; // User is idle, safe to send reminder
}

/**
 * Extract context from session for user-friendly reminder
 * @param {object} session - Coaching session data
 * @returns {object} Context with topic and subject
 */
async function extractSessionContext(session) {
  // Strategy 1: Use lesson plan if available
  if (session.lesson_plan_text) {
    const lpPreview = session.lesson_plan_text.substring(0, 200);
    const topicMatch = lpPreview.match(/topic[:\s]+([^\n]+)/i);
    const subjectMatch = lpPreview.match(/subject[:\s]+([^\n]+)/i);

    if (topicMatch || subjectMatch) {
      return {
        topic: topicMatch?.[1]?.trim() || 'your lesson',
        subject: subjectMatch?.[1]?.trim() || null
      };
    }
  }

  // Strategy 2: Extract from transcript first meaningful content
  if (session.transcript_text) {
    const cleanedTranscript = session.transcript_text
      .replace(/\[\d+:\d+\]\s*(Teacher|Student)\s*\([A-Z]{2}\):\s*/gi, '')
      .trim();

    const words = cleanedTranscript.split(/\s+/).slice(0, 50);
    const topicPreview = words.join(' ') + '...';

    // Detect subject from keywords
    const subjectKeywords = {
      'math': ['number', 'add', 'subtract', 'multiply', 'equation', 'geometry', 'count'],
      'english': ['read', 'write', 'letter', 'word', 'sentence', 'story', 'alphabet'],
      'urdu': ['حروف', 'لفظ', 'جملہ', 'پڑھنا', 'لکھنا'],
      'science': ['plant', 'animal', 'body', 'experiment', 'observe', 'earth']
    };

    let detectedSubject = null;
    for (const [subject, keywords] of Object.entries(subjectKeywords)) {
      if (keywords.some(kw => cleanedTranscript.toLowerCase().includes(kw))) {
        detectedSubject = subject;
        break;
      }
    }

    return {
      topic: topicPreview,
      subject: detectedSubject
    };
  }

  // Strategy 3: Fallback to date
  const createdDate = new Date(session.created_at);
  return {
    topic: `your ${createdDate.toLocaleDateString()} classroom recording`,
    subject: null
  };
}

/**
 * Send reminder message for stale session
 * @param {object} session - Coaching session with user data
 */
async function sendSessionReminder(session) {
  try {
    const context = await extractSessionContext(session);
    const questionsAnswered = session.conversation_state?.questions_answered || 0;
    const questionsRemaining = 3 - questionsAnswered;

    // Build contextual message
    let reminderText;

    if (context.subject) {
      reminderText = `Hi ${displayName(session.users, 'there', { firstOnly: true })}! 👋\n\n` +
        `You have an incomplete coaching session for your ${context.subject} lesson` +
        (questionsAnswered > 0
          ? ` (${questionsAnswered}/3 reflections completed).\n\n`
          : `.\n\n`) +
        `Ready to continue? I just have ${questionsRemaining} more question${questionsRemaining > 1 ? 's' : ''} for you!`;
    } else {
      reminderText = `Hi ${displayName(session.users, 'there', { firstOnly: true })}! 👋\n\n` +
        `You started a coaching session but didn't finish the reflective conversation.\n\n` +
        (questionsAnswered > 0
          ? `✅ Progress: ${questionsAnswered}/3 questions answered\n\n`
          : '') +
        `Would you like to continue and get your personalized feedback?`;
    }

    // Send interactive message with buttons
    await WhatsAppService.sendInteractiveButtons(session.recipient_identifier, {
      body: reminderText,
      buttons: [
        { id: `coaching_continue_${session.id}`, title: 'Continue Now' },
        { id: `coaching_finish_${session.id}`, title: 'Get Report Now' }
      ]
    });

    // Record that reminder was sent
    await supabase
      .from('coaching_sessions')
      .update({
        reminder_sent_at: new Date().toISOString(),
        conversation_state: {
          ...session.conversation_state,
          reminder_sent: true,
          reminder_sent_at: new Date().toISOString()
        }
      })
      .eq('id', session.id);

    logToFile('📨 Coaching reminder sent', {
      sessionId: session.id,
      userId: session.user_id,
      questionsAnswered,
      contextTopic: context.topic?.substring(0, 50)
    });
  } catch (error) {
    logToFile('❌ Failed to send reminder', {
      sessionId: session.id,
      error: error.message
    });
  }
}

/**
 * Auto-complete session with partial report
 * @param {object} session - Coaching session with user data
 */
async function autoCompleteSession(session) {
  try {
    const questionsAnswered = session.conversation_state?.questions_answered || 0;

    logToFile('🔄 Auto-completing stale coaching session', {
      sessionId: session.id,
      questionsAnswered,
      totalQuestions: 3
    });

    // 1. Update conversation state to mark as auto-completed
    const updatedState = {
      ...session.conversation_state,
      current_state: 'AUTO_COMPLETED',
      auto_completed: true,
      auto_completed_at: new Date().toISOString(),
      reflective_skipped: questionsAnswered < 3,
      questions_at_completion: questionsAnswered
    };

    await supabase
      .from('coaching_sessions')
      .update({
        conversation_state: updatedState,
        status: 'generating_report'
      })
      .eq('id', session.id);

    // 2. Queue report generation with partial flag
    await CoachingJobQueueService.queueReport(session.id, {
      from: session.recipient_identifier,
      partial: questionsAnswered < 3,
      autoCompleted: true
    });

    // 3. Notify user
    const notificationText = questionsAnswered > 0
      ? `Hi ${displayName(session.users, 'there', { firstOnly: true })}! I noticed you didn't get back to complete your coaching session. ` +
        `No worries - I'm generating your report now based on the ${questionsAnswered} reflection${questionsAnswered > 1 ? 's' : ''} you provided. 📊`
      : `Hi ${displayName(session.users, 'there', { firstOnly: true })}! Since you didn't continue the reflective conversation, ` +
        `I'm generating your coaching report based on the classroom audio analysis. 📊`;

    await WhatsAppService.sendMessage(session.recipient_identifier, notificationText);

    logToFile('✅ Auto-complete initiated', {
      sessionId: session.id,
      questionsAnswered,
      notificationSent: true
    });
  } catch (error) {
    logToFile('❌ Failed to auto-complete session', {
      sessionId: session.id,
      error: error.message
    });
  }
}

// ── Observe delivery sweeps ─────────────────────────────────────────────
//
// The planners decide (observe-untapped / observe-undelivered, pure); the
// observe-send executors act. Each sweep: a kill switch
// (OBSERVE_*_SWEEP_OFF=true), single-flight across replicas (a Redis lock, so
// several workers send one set of messages), a per-tick cap taking the oldest
// first, and a log line every tick — including the ticks that found nothing.

const OBSERVE_SWEEP_LOCK_TTL_SECONDS = 10 * 60;
const OBSERVE_SWEEP_READ_LIMIT = 500;

const isSweepOff = (name) => ['true', '1', 'yes'].includes(String(process.env[name] || '').trim().toLowerCase());
const perTickCap = (name, dflt) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

const REDIS_READY_WAIT_MS = 5000;

async function withSweepLock(lockName, tally, fn) {
  // Lazy: requiring this worker as a library must not touch Redis.
  const RedisService = require('../shared/services/cache/railway-redis.service');
  // This worker runs as a one-shot cron: the sweeps start moments after the
  // process does, before the Redis connection is ready, and acquireLock fails
  // closed on a not-ready client — so without this wait every run skipped.
  const readyBy = Date.now() + REDIS_READY_WAIT_MS;
  while (typeof RedisService.isAvailable === 'function' && !RedisService.isAvailable() && Date.now() < readyBy) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const lockId = `${process.pid}-${Date.now()}`;
  const gotLock = await RedisService.acquireLock(lockName, lockId, OBSERVE_SWEEP_LOCK_TTL_SECONDS);
  if (!gotLock) {
    // Fails closed: a message not sent this tick is sent next tick; one sent
    // by six replicas cannot be unsent. Never silent, though.
    logToFile(`🔔 ${lockName} skipped — lock held elsewhere or cache unreachable`, tally);
    return { ...tally, skippedLocked: true };
  }
  try {
    return await fn();
  } finally {
    await RedisService.releaseLock(lockName, lockId).catch(() => {});
  }
}

async function readObserveRows(filter) {
  let q = supabase
    .from('coaching_sessions')
    .select('id, status, observer_user_id, updated_at, created_at, analysis_data')
    .eq('observation_type', 'leader_observation');
  q = filter(q);
  const { data, error } = await q.order('updated_at', { ascending: true }).limit(OBSERVE_SWEEP_READ_LIMIT);
  if (error) throw new Error(`observe sweep read failed: ${error.message}`);
  return data || [];
}

/** Reports whose invite was never tapped: one nudge, then tell the coach. */
async function runUntappedSweep(nowMs = Date.now()) {
  const tally = { scanned: 0, found: 0, nudged: 0, gaveUp: 0, expired: 0, skipped: 0, failed: 0, remaining: 0 };
  if (isSweepOff('OBSERVE_UNTAPPED_SWEEP_OFF')) {
    logToFile('🔔 observe untapped sweep off', tally);
    return { ...tally, disabled: true };
  }
  return withSweepLock('observe-untapped-sweep', tally, async () => {
    const ObserveSend = require('../shared/services/observe/observe-send.service');
    const { classifyUntappedDelivery } = require('../shared/services/observe/observe-untapped.service');
    const { TERMINAL_IN_FILTER } = require('../shared/services/observe/observe-terminal');
    const rows = await readObserveRows((q) => q.not('status', 'in', TERMINAL_IN_FILTER));
    const deliveryOf = (r) => (r.analysis_data && r.analysis_data.teacher_delivery) || {};
    const actionable = rows.filter((r) => classifyUntappedDelivery(deliveryOf(r), nowMs).action !== 'skip');
    tally.scanned = rows.length;
    tally.found = actionable.length;
    const batch = actionable.slice(0, perTickCap('OBSERVE_UNTAPPED_MAX_PER_TICK', 25));
    tally.remaining = actionable.length - batch.length;
    for (const row of batch) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const { action } = await ObserveSend.processUntappedDelivery(row.id, nowMs);
        if (action === 'nudge') tally.nudged += 1;
        else if (action === 'give_up') tally.gaveUp += 1;
        else if (action === 'expire') tally.expired += 1;
        else tally.skipped += 1;
      } catch (err) {
        tally.failed += 1;
        logToFile('⚠️ observe untapped sweep: failed on one report', { sessionId: row.id, error: err.message });
      }
    }
    logToFile('🔔 observe untapped sweep done', tally);
    return tally;
  });
}

/** Finished observations whose report was never sent: one reminder, then say so. */
async function runUndeliveredSweep(nowMs = Date.now()) {
  const tally = { scanned: 0, found: 0, reminded: 0, gaveUp: 0, expired: 0, skipped: 0, failed: 0, remaining: 0 };
  if (isSweepOff('OBSERVE_UNDELIVERED_SWEEP_OFF')) {
    logToFile('🔔 observe undelivered sweep off', tally);
    return { ...tally, disabled: true };
  }
  return withSweepLock('observe-undelivered-sweep', tally, async () => {
    const ObserveSend = require('../shared/services/observe/observe-send.service');
    const {
      classifyUndelivered, candidateFromSession, FINISHED_SESSION_STATUSES,
    } = require('../shared/services/observe/observe-undelivered.service');
    const rows = await readObserveRows((q) => q.in('status', [...FINISHED_SESSION_STATUSES]));
    const actionable = rows.filter((r) => classifyUndelivered(candidateFromSession(r), nowMs).action !== 'skip');
    tally.scanned = rows.length;
    tally.found = actionable.length;
    const batch = actionable.slice(0, perTickCap('OBSERVE_UNDELIVERED_MAX_PER_TICK', 25));
    tally.remaining = actionable.length - batch.length;
    for (const row of batch) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const { action } = await ObserveSend.processUndeliveredDelivery(row.id, nowMs);
        if (action === 'remind') tally.reminded += 1;
        else if (action === 'give_up') tally.gaveUp += 1;
        else if (action === 'expire') tally.expired += 1;
        else tally.skipped += 1;
      } catch (err) {
        tally.failed += 1;
        logToFile('⚠️ observe undelivered sweep: failed on one report', { sessionId: row.id, error: err.message });
      }
    }
    logToFile('🔔 observe undelivered sweep done', tally);
    return tally;
  });
}

// Gated — requiring this file as a library (e.g. from a test harness) does
// NOT fire the stale-session sweep. To run the sweep manually, invoke the
// exported `main` function.
if (require.main === module) {
  main();
}

module.exports = { main, processStaleCoachingSessions, runUntappedSweep, runUndeliveredSweep };
