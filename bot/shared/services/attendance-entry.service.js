/**
 * The chat door into attendance, and the one place a conversation result becomes
 * messages.
 *
 * text-message.handler.js used to carry all of this inline — twice: once for a
 * message inside an attendance session and once for a fresh "attendance". The two
 * copies had already drifted (the fresh door had no answer for RATE_LIMITED, so the
 * sixth start in five minutes got silence). The handler now asks two questions, in
 * its existing order, and this module answers both:
 *
 *   handleInSession  — the teacher is mid-session; route the reply by state
 *   handleTrigger    — "attendance", "حاضری", "attendance 30 sep", "class attendance"
 *
 * Both resolve true when the message was attendance's to handle.
 *
 * Every send goes through the messaging facade, so the same code serves WhatsApp
 * (Meta Flow or Baileys text flow), Slack and Discord (tap-to-mark modals) and any
 * channel whose sendFlow() runs the text stand-in (Matrix).
 */

const WhatsAppService = require('./whatsapp.service');
const AttendanceConversationService = require('./attendance-conversation.service');
const AttendanceDetectorService = require('./attendance-detector.service');
const AttendanceDeliveryService = require('./attendance-delivery.service');
const AttendanceDates = require('./attendance-dates');
const { driverForIdentifier } = require('./messaging/channel-registry');
const { logToFile } = require('../utils/logger');

const CANCEL_WORDS = ['cancel', 'منسوخ'];
const EVERYONE_PRESENT_KEYWORDS = ['everyone present', 'all present', 'سب حاضر', 'سب موجود', '3'];

/** A head teacher who also teaches says "class attendance" to reach their class. */
function requestedSubject(messageBody) {
  return /\bclass\b|\bclasses\b|کلاس/i.test(String(messageBody || '')) ? 'class' : undefined;
}

/** Why a named day was refused, in words. */
function dateRefusal(error) {
  if (error.error === 'future') return 'That day is in the future — attendance can only be marked for today or an earlier day.';
  if (error.error === 'too_old') return `That day is more than ${error.maxBack} days ago, too far back to correct here.`;
  return 'I could not read that date. Try "attendance yesterday", "attendance 30 sep" or "attendance 2026-09-30".';
}

/**
 * Start (or restart) a session from a trigger message: reads the named day and,
 * for a head teacher, whether they asked for their class instead of their staff.
 *
 * @returns {Promise<Object>} the conversation service's result, or an ERROR for a refused day
 */
async function startFromMessage(userId, messageBody) {
  const named = AttendanceDates.parseRequestedDate(messageBody);
  if (named && named.error) return { action: 'ERROR', message: dateRefusal(named) };
  return AttendanceConversationService.startAttendanceSession(userId, {
    selectedDate: named ? named.date : undefined,
    subject: requestedSubject(messageBody),
    forceNew: true,
  });
}

/** Open the tap-to-mark form on whichever channel the teacher is on. */
async function sendMarkingForm(user, from, result) {
  // Slack/Discord have a real Flow-equivalent (attendance_mark's modal — see
  // slack-flow-registry.js / discord-flow-registry.js), not sendFlow()'s
  // {flowId, flowToken} contract. The roster the modal needs is already in the
  // Redis session handleMarkingMethodSelection just saved — the modal's INIT
  // reads it back by userId.
  if (driverForIdentifier(from) === 'slack') {
    await WhatsAppService.sendInteractiveButtons(from, {
      body: result.message,
      buttons: [{ id: 'open_modal:attendance_mark', title: 'Mark Attendance' }],
    });
    return;
  }
  if (driverForIdentifier(from) === 'discord') {
    await WhatsAppService.sendInteractiveButtons(from, {
      body: result.message,
      buttons: [{ id: 'discord_start_flow:attendance_mark', title: 'Mark Attendance' }],
    });
    return;
  }

  // eslint-disable-next-line global-require -- text-flow definitions pull in endpoint modules lazily
  const { markingFlowToken } = require('./messaging/text-flow-definitions');
  const sessionState = await AttendanceConversationService.getSessionState(user.id);
  const isStaff = sessionState?.subject === 'staff';
  const displayName = result.selectedClass
    ? AttendanceConversationService.formatClassDisplayName(result.selectedClass)
    : 'Class';
  // Flow token: userId:target:date:sessionType:encodedName — everything the
  // submission handler needs, for a class (target = list id) or staff.
  const flowToken = markingFlowToken(user.id, {
    ...sessionState,
    selectedDate: sessionState?.selectedDate || AttendanceDates.todayString(),
  });

  // Channels with no real Flow (Baileys, Matrix) degrade sendFlow() to the
  // 'attendance-mark' text-flow definition via flowKind; Meta ignores flowKind
  // and opens the real Flow. Called unconditionally (not gated behind
  // ATTENDANCE_MARKING_FLOW_ID) so a text channel gets tap-to-mark with no Meta
  // Flow registered — the boolean return decides whether to fall back.
  const markingSent = await WhatsAppService.sendFlow(from, {
    flowId: process.env.ATTENDANCE_MARKING_FLOW_ID || '',
    flowKind: 'attendance-mark',
    header: isStaff ? `📋 ${displayName} Staff Attendance` : `📋 ${displayName} Attendance`,
    body: result.message,
    buttonText: 'Mark Attendance',
    // Note: Don't specify screen for data_api_version 3.0+ flows with endpoint
    // The endpoint determines first screen via INIT response
    flowToken,
  });

  if (markingSent) {
    logToFile('📋 Sent attendance marking flow', {
      userId: user.id,
      subject: isStaff ? 'staff' : 'class',
      target: isStaff ? sessionState?.schoolId : sessionState?.selectedListId,
      rosterSize: result.students?.length,
    });
  } else {
    // The session already moved on to wait for the form's answer; put it back on
    // the method menu so the "1" or "3" offered here is answered as promised.
    await AttendanceConversationService.saveSessionState(user.id, {
      ...sessionState,
      state: AttendanceConversationService.STATES.AWAITING_MARKING_METHOD,
    });
    await WhatsAppService.sendMessage(from, 'The marking form is not available on this channel. Reply *1* to mark by voice note, or *3* if everyone is present.');
    logToFile('⚠️ Attendance marking flow unavailable on this channel', { userId: user.id });
  }
}

/** Save the session's records and deliver the month's register. */
async function generateAndDeliver(user, from, result) {
  await WhatsAppService.sendMessage(from, result.message);

  try {
    const sessionState = await AttendanceConversationService.getSessionState(user.id);
    const deliveryResult = await AttendanceDeliveryService.processAndDeliver(user.id, from, {
      subject: sessionState?.subject,
      schoolId: sessionState?.schoolId,
      selectedClass: result.selectedClass || sessionState?.selectedClass,
      selectedListId: sessionState?.selectedListId,
      records: result.records,
      summary: sessionState?.summary,
      transcript: sessionState?.transcript,
      markingMethod: sessionState?.markingMethod || 'voice',
      sessionDate: sessionState?.selectedDate,
      sessionType: sessionState?.sessionType,
    });

    // Clear state either way, so a failure cannot leave the teacher stuck in PROCESSING.
    await AttendanceConversationService.clearSessionState(user.id);
    if (!deliveryResult.success) {
      logToFile('📋 Cleared session state after delivery failure', { userId: user.id, saved: deliveryResult.saved, error: deliveryResult.error });
      await WhatsAppService.sendMessage(from, deliveryResult.saved
        ? deliveryResult.error
        : `Sorry, there was an error saving your attendance: ${deliveryResult.error}\n\nSay "attendance" to try again.`);
    } else {
      logToFile('📋 Cleared session state after successful delivery', { userId: user.id });
    }
  } catch (deliveryError) {
    await AttendanceConversationService.clearSessionState(user.id);
    logToFile('Attendance delivery error - state cleared', { error: deliveryError.message, userId: user.id });
    await WhatsAppService.sendMessage(from, 'Sorry, something went wrong delivering your attendance file. Say "attendance" to try again.');
  }
}

/**
 * Turn one conversation result into what the teacher sees.
 */
async function respond(user, from, result) {
  switch (result.action) {
    case 'SEND_MARKING_FLOW':
      return sendMarkingForm(user, from, result);
    case 'GENERATE_ATTENDANCE':
      return generateAndDeliver(user, from, result);
    case 'SEND_SETUP_FLOW':
      return sendSetupFlow(user, from, result);
    default:
      // ASK_* / AWAIT_VOICE_INPUT / PROMPT_VOICE / VERIFY_ATTENDANCE / SESSION_* /
      // INVALID_* / PROCESSING / RATE_LIMITED / ERROR all carry a message to show.
      if (result.message) await WhatsAppService.sendMessage(from, result.message);
      return undefined;
  }
}

/** No class yet — set one up, as a Flow or as the text equivalent. */
async function sendSetupFlow(user, from, result) {
  if (driverForIdentifier(from) === 'slack') {
    await WhatsAppService.sendInteractiveButtons(from, {
      body: result.message,
      buttons: [{ id: 'open_modal:attendance', title: 'Set Up Class' }],
    });
    return;
  }
  if (driverForIdentifier(from) === 'discord') {
    await WhatsAppService.sendInteractiveButtons(from, {
      body: result.message,
      buttons: [{ id: 'discord_start_flow:attendance', title: 'Set Up Class' }],
    });
    return;
  }

  const setupSent = await WhatsAppService.sendFlow(from, {
    flowId: process.env.ATTENDANCE_SETUP_FLOW_ID || '',
    flowKind: 'class-setup',
    header: '📋 Class Setup',
    body: result.message,
    buttonText: 'Set Up Class',
    screen: 'CLASS_INFO',
    flowToken: user.id, // Pass user ID so endpoint can create class for correct user
  });
  if (setupSent) {
    logToFile('📋 Sent attendance setup flow', { userId: user.id });
  } else {
    // Neither a Flow nor a text flow is available — say what we know.
    await WhatsAppService.sendMessage(from, result.message);
    logToFile('⚠️ Class setup unavailable on this channel, sent text message instead', { userId: user.id });
  }
}

/**
 * A message from someone mid-session.
 *
 * @returns {Promise<boolean>} true when attendance handled it
 */
async function handleInSession({ user, from, messageBody, typingController }) {
  if (!user?.id) return false;
  try {
    const isInAttendanceSession = await AttendanceConversationService.isInAttendanceSession(user.id);
    if (!isInAttendanceSession) return false;

    logToFile('📋 User in active attendance session, routing message', { userId: user.id });
    const sessionState = await AttendanceConversationService.getSessionState(user.id);
    const STATES = AttendanceConversationService.STATES;
    const lower = String(messageBody || '').toLowerCase();

    if (CANCEL_WORDS.includes(lower.trim())) {
      typingController?.stop();
      const cancelled = await AttendanceConversationService.cancelSession(user.id);
      await WhatsAppService.sendMessage(from, cancelled.message);
      return true;
    }

    let result;

    // A fresh attendance trigger sent while already mid-flow means the teacher
    // wants to start over, not answer whatever prompt is pending — without this a
    // stuck or half-abandoned session has no way back in except typing "cancel"
    // first. Excluded from PROCESSING, which has its own wait/timeout handling.
    const retrigger = AttendanceDetectorService.detectAttendanceIntent(messageBody);
    if (sessionState.state !== STATES.PROCESSING && retrigger.detected) {
      logToFile('📋 Attendance trigger received mid-session, restarting', { userId: user.id, previousState: sessionState.state });
      await AttendanceConversationService.clearSessionState(user.id);
      result = await startFromMessage(user.id, messageBody);
    } else {
      switch (sessionState.state) {
        case STATES.AWAITING_CLASS_SELECTION:
          result = await AttendanceConversationService.handleClassSelection(user.id, messageBody);
          break;

        case STATES.AWAITING_MARKING_METHOD:
          if (EVERYONE_PRESENT_KEYWORDS.some(kw => lower.includes(kw))) {
            result = await AttendanceConversationService.handleEveryonePresent(user.id);
          } else {
            result = await AttendanceConversationService.handleMarkingMethodSelection(user.id, messageBody);
          }
          break;

        case STATES.AWAITING_VOICE_INPUT:
          // Text when a voice note is expected — prompt, or switch to tapping.
          if (messageBody === '2' || lower.includes('tap')) {
            await AttendanceConversationService.saveSessionState(user.id, {
              ...sessionState, state: STATES.AWAITING_MARKING_METHOD,
            });
            result = await AttendanceConversationService.handleMarkingMethodSelection(user.id, '2');
          } else {
            result = {
              action: 'PROMPT_VOICE',
              message: 'Please send a *voice message* with your roll call.\n\nOr reply "2" to switch to Tap to Mark.'
            };
          }
          break;

        case STATES.AWAITING_VERIFICATION:
          result = await AttendanceConversationService.handleVerificationResponse(user.id, messageBody);
          break;

        case STATES.AWAITING_DATE_SELECTION:
          result = await AttendanceConversationService.handleDateSelection(user.id, messageBody);
          break;

        case STATES.AWAITING_SESSION_TYPE:
          result = await AttendanceConversationService.handleSessionTypeSelection(user.id, messageBody);
          break;

        case STATES.IDLE:
        case STATES.COMPLETED:
          logToFile('📋 Attendance session idle/completed, restarting', { userId: user.id, state: sessionState.state });
          await AttendanceConversationService.clearSessionState(user.id);
          result = await startFromMessage(user.id, messageBody);
          break;

        case STATES.PROCESSING:
          if (AttendanceConversationService.isProcessingTimedOut(sessionState)) {
            logToFile('⚠️ Processing timeout detected, clearing stuck state', { userId: user.id, processingStartedAt: sessionState.processingStartedAt });
            await AttendanceConversationService.clearSessionState(user.id);
            result = {
              action: 'ERROR',
              message: 'Your previous attendance session timed out. Say "attendance" to start a new one.'
            };
          } else {
            result = {
              action: 'PROCESSING',
              message: 'Your attendance is being processed. Please wait a moment...'
            };
          }
          break;

        default:
          logToFile('⚠️ Unknown attendance state, clearing session', { userId: user.id, state: sessionState?.state });
          await AttendanceConversationService.clearSessionState(user.id);
          result = {
            action: 'ERROR',
            message: 'Something went wrong with attendance. Say "attendance" to start again.'
          };
      }
    }

    typingController?.stop();
    await respond(user, from, result);
    return true;
  } catch (error) {
    logToFile('Error checking attendance session', { error: error.message, userId: user?.id });
    // Continue with normal flow if attendance check fails
    return false;
  }
}

/**
 * A fresh "attendance" (any spelling the detector knows, optionally naming a day).
 *
 * @returns {Promise<boolean>} true when attendance handled it
 */
async function handleTrigger({ user, from, messageBody, typingController }) {
  if (!user?.id) return false;
  const detection = AttendanceDetectorService.detectAttendanceIntent(messageBody);
  if (!detection.detected) return false;

  logToFile('📋 Attendance keyword detected, starting session', { userId: user.id, message: messageBody, confidence: detection.confidence });
  typingController?.stop();

  try {
    const result = await startFromMessage(user.id, messageBody);
    await respond(user, from, result);
  } catch (error) {
    logToFile('Error starting attendance session', { error: error.message, userId: user?.id });
    await WhatsAppService.sendMessage(from, 'Sorry, something went wrong. Please try again.');
  }
  return true;
}

module.exports = {
  handleInSession,
  handleTrigger,
  respond,
  requestedSubject,
  startFromMessage,
};
