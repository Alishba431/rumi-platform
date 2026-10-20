/**
 * Attendance Delivery Service
 * Saves a marked day, then regenerates and delivers the month's register.
 *
 * Created: January 24, 2026
 * Updated: January 25, 2026 (Monthly cumulative register)
 *
 * Flow:
 * 1. Save the day FIRST (so it is in the monthly query). Re-marking a day that is
 *    already on file REPLACES it — a teacher correcting a mistake must not hit a
 *    duplicate guard.
 * 2. Fetch ALL sessions for the month the day falls in (cumulative)
 * 3. Generate the MONTHLY register (attendance-register.service)
 * 4. Archive to R2 when it is configured — storage is an archive, never a gate
 * 5. Send the document to whoever marked it, through the messaging facade
 * 6. Clear conversation state
 *
 * Dates are 'YYYY-MM-DD' strings throughout (attendance-dates): taken through
 * `new Date(...)` they slid a day either side of UTC.
 */

const AttendanceGeneratorService = require('./attendance-generator.service');
const AttendanceRegister = require('./attendance-register.service');
const AttendanceDates = require('./attendance-dates');
const WhatsAppService = require('./whatsapp.service');
const AttendanceConversationService = require('./attendance-conversation.service');
const { logToFile } = require('../utils/logger');
const { deliverRegisterFile } = require('./attendance-register-delivery.service');
const crypto = require('crypto');
const supabase = require('../config/supabase');

class AttendanceDeliveryService {
  /**
   * Process and deliver attendance for a completed session
   * Generates a MONTHLY CUMULATIVE register
   *
   * @param {string} userId - User UUID
   * @param {string} phoneNumber - The address the teacher wrote from (any channel)
   * @param {Object} sessionData - Session data from conversation state
   * @returns {Promise<Object>} Delivery result
   */
  static async processAndDeliver(userId, phoneNumber, sessionData) {
    if (sessionData && sessionData.subject === 'staff') {
      const StaffAttendanceService = require('./staff-attendance.service');
      const result = await StaffAttendanceService.saveAndDeliver(userId, phoneNumber, sessionData);
      await AttendanceConversationService.clearSessionState(userId);
      return result;
    }

    const startTime = Date.now();
    let saved = false;

    try {
      const listId = sessionData.selectedListId;
      const className = sessionData.selectedClass?.class_name || 'Unknown Class';
      const section = sessionData.selectedClass?.section || null;
      const sessionDate = AttendanceDates.toDateString(sessionData.sessionDate);

      logToFile('📊 Starting attendance delivery (monthly cumulative)', {
        userId,
        className,
        section,
        listId,
        sessionDate,
        recordCount: sessionData.records?.length
      });

      const metadata = {
        userId,
        className,
        section,
        date: sessionDate,
        sessionType: sessionData.sessionType || 'full_day'
      };

      // Step 1: Save to database FIRST (so it's included in monthly query)
      const dbResult = await this.saveToDatabase(userId, sessionData, null, metadata);
      saved = true;

      // Step 2: Fetch all attendance data for the month the day falls in
      const { month, year } = AttendanceDates.monthBounds(sessionDate);
      const { students, sessions } = await this.getMonthlyAttendanceData(listId, month, year);

      logToFile('Monthly data retrieved', {
        studentCount: students.length,
        sessionCount: sessions.length
      });

      // Step 3: Generate MONTHLY register Excel buffer
      const excelBuffer = await AttendanceGeneratorService.createMonthlyRegisterBufferFromData(
        { className, section },
        month,
        year,
        students,
        sessions
      );

      const title = section ? `${className} - ${section}` : className;
      const fileName = AttendanceRegister.formatMonthlyFileName(title, month, year, 'student');
      const caption = this.generateMonthlyCaptionSimple(
        className, section, month, year, dbResult.summary, sessionDate, { replaced: dbResult.replaced }
      );

      // Steps 4-5: archive (best effort) and send
      const delivery = await deliverRegisterFile({
        to: phoneNumber,
        buffer: excelBuffer,
        fileName,
        caption,
        r2Key: `attendance/${userId}/monthly/${year}/${month}/${fileName}`
      });

      if (delivery.url && dbResult.sessionId) {
        await supabase
          .from('attendance_sessions')
          .update({ excel_url: delivery.url })
          .eq('id', dbResult.sessionId);
      }

      // Step 6: Clear conversation state
      await AttendanceConversationService.clearSessionState(userId);

      logToFile(delivery.sent ? '✅ Monthly attendance delivery complete' : '⚠️ Attendance saved but the register was not delivered', {
        userId,
        elapsedMs: Date.now() - startTime,
        fileName,
        sessionId: dbResult.sessionId,
        replaced: dbResult.replaced,
        sessionCount: sessions.length,
        sent: delivery.sent
      });

      if (!delivery.sent) {
        return {
          success: false,
          saved: true,
          sessionId: dbResult.sessionId,
          error: 'Your attendance is saved, but the register file could not be sent on this channel.'
        };
      }

      return {
        success: true,
        saved: true,
        replaced: dbResult.replaced,
        sessionId: dbResult.sessionId,
        excelUrl: delivery.url,
        fileName,
        caption,
        elapsedMs: Date.now() - startTime
      };

    } catch (error) {
      logToFile('❌ Attendance delivery failed', {
        userId,
        saved,
        error: error.message,
        stack: error.stack
      });

      return {
        success: false,
        saved,
        error: error.message
      };
    }
  }

  /**
   * Get all attendance data for a class in a given month
   *
   * @param {string} listId - Student list ID
   * @param {number} month - Month (1-12)
   * @param {number} year - Year
   * @returns {Promise<{students: Array, sessions: Array}>}
   */
  static async getMonthlyAttendanceData(listId, month, year) {
    // Bounds from the date string: the old `new Date(year, month, 0).toISOString()`
    // was the day before east of UTC, so the month's last day fell out of the query.
    const { start: startDate, end: endDate } = AttendanceDates.monthBounds(`${year}-${String(month).padStart(2, '0')}-01`);

    logToFile('📊 Querying monthly attendance data', { listId, month, year, startDate, endDate });

    // Get all students in the class
    const { data: students, error: studentsError } = await supabase
      .from('students')
      .select('id, roll_number, student_name, father_name')
      .eq('list_id', listId)
      .eq('is_active', true)
      .order('roll_number');

    if (studentsError) {
      logToFile('Error fetching students for monthly register', { error: studentsError.message });
    }

    // Get all attendance sessions for the month with records
    const { data: sessions, error: sessionsError } = await supabase
      .from('attendance_sessions')
      .select(`
        id,
        session_date,
        session_type,
        attendance_records (
          student_id,
          status
        )
      `)
      .eq('list_id', listId)
      .gte('session_date', startDate)
      .lte('session_date', endDate)
      .order('session_date');

    if (sessionsError) {
      logToFile('Error fetching sessions for monthly register', { error: sessionsError.message });
    }

    return {
      students: students || [],
      sessions: sessions || []
    };
  }

  /**
   * Caption for the monthly register document
   * @param {string} className - Class name
   * @param {string|null} section - Section
   * @param {number} month - Month (1-12)
   * @param {number} year - Year
   * @param {Object} daySummary - The marked day's { present, absent, leave }
   * @param {string} sessionDate - The day marked, YYYY-MM-DD
   * @param {Object} [opts]
   * @param {boolean} [opts.replaced] - The day was already on file and was corrected
   */
  static generateMonthlyCaptionSimple(className, section, month, year, daySummary, sessionDate, { replaced = false } = {}) {
    const displayName = section ? `${className} - ${section}` : className;
    const dateDisplay = AttendanceDates.formatDisplayDate(AttendanceDates.toDateString(sessionDate));

    const lines = [
      `📋 *Monthly Attendance Register*`,
      `📚 ${displayName}`,
      `📅 ${AttendanceRegister.MONTH_NAMES[month - 1]} ${year}`,
      '',
      replaced ? `${dateDisplay} — updated:` : `${dateDisplay}:`,
      `✅ Present: ${daySummary?.present || 0}`,
      `❌ Absent: ${daySummary?.absent || 0}`,
      `🟡 On leave: ${daySummary?.leave || 0}`,
      '',
      'This file holds the whole month so far — the newest copy replaces the last.'
    ];

    return lines.join('\n');
  }

  /**
   * Is this class/date/session already on file?
   */
  static async checkExistingSession(listId, sessionDate, sessionType) {
    try {
      const { data, error } = await supabase
        .from('attendance_sessions')
        .select('id, present_count, absent_count, total_students, excel_url, created_at')
        .eq('list_id', listId)
        .eq('session_date', AttendanceDates.toDateString(sessionDate))
        .eq('session_type', sessionType)
        .maybeSingle();

      if (error) {
        logToFile('⚠️ Error checking existing session', { error: error.message });
        return null;
      }

      return data; // null if not exists, session object if exists
    } catch (error) {
      logToFile('⚠️ Exception checking existing session', { error: error.message });
      return null;
    }
  }

  /**
   * Save a class's day: one session row, one record per student.
   *
   * A day already on file is REPLACED — its records rewritten, its tallies
   * updated — rather than refused. The old duplicate guard dead-ended a teacher who
   * had made a mistake; a correction is the commonest reason to mark a day twice.
   * The new records are written BEFORE the old ones are removed, and the tallies
   * last, so a write that fails part-way leaves the day already on file intact
   * (if removing the old ones fails, the new ones are taken back out).
   *
   * Only the teacher whose class it is can file or replace its day: a stray token
   * or session naming someone else's list is refused before anything is written.
   *
   * @returns {Promise<{sessionId: string, replaced: boolean, summary: Object}>}
   */
  static async saveToDatabase(userId, sessionData, excelUrl, metadata) {
    const listId = sessionData.selectedListId;
    const records = sessionData.records || [];
    const sessionDateStr = AttendanceDates.toDateString(metadata.date);
    const sessionType = metadata.sessionType || 'full_day';

    const summary = {
      total: records.length,
      present: records.filter(r => r.status === 'present').length,
      absent: records.filter(r => r.status === 'absent').length,
      leave: records.filter(r => r.status === 'leave').length
    };

    const { data: list } = await supabase
      .from('student_lists')
      .select('id, user_id')
      .eq('id', listId)
      .maybeSingle();
    if (!list || list.user_id !== userId) {
      logToFile('❌ Attendance refused: the class is not this teacher\'s', { listId, userId, owner: list?.user_id || null });
      throw new Error('This class is not on your account');
    }

    const existingSession = await this.checkExistingSession(listId, sessionDateStr, sessionType);
    const counts = {
      total_students: summary.total,
      present_count: summary.present,
      absent_count: summary.absent,
      leave_count: summary.leave
    };

    let sessionId;
    let oldRecordIds = [];
    if (existingSession) {
      sessionId = existingSession.id;
      logToFile('📋 Day already on file — replacing it', { sessionId, listId, sessionDate: sessionDateStr });

      const { data: oldRecords, error: oldError } = await supabase
        .from('attendance_records')
        .select('id')
        .eq('session_id', sessionId);
      if (oldError) {
        throw new Error(`Failed to read the day on file: ${oldError.message}`);
      }
      oldRecordIds = (oldRecords || []).map(r => r.id);
    } else {
      const { data: session, error: sessionError } = await supabase
        .from('attendance_sessions')
        .insert({
          user_id: userId,
          list_id: listId,
          session_date: sessionDateStr,
          session_type: sessionType,
          marking_method: sessionData.markingMethod || 'voice',
          transcript: sessionData.transcript || null,
          excel_url: excelUrl,
          ...counts
        })
        .select('id')
        .single();

      if (sessionError) {
        // Fail loudly instead of silently continuing with empty Excel
        logToFile('❌ Database session insert failed - aborting', {
          error: sessionError.message,
          listId,
          userId,
          hint: 'This may be caused by an invalid list_id (class was deleted)'
        });
        throw new Error(`Failed to save attendance session: ${sessionError.message}`);
      }
      sessionId = session.id;
    }

    // Ids chosen here, so a replace that fails after this insert can take
    // exactly these rows back out again.
    const recordInserts = records.map(r => ({
      id: crypto.randomUUID(),
      session_id: sessionId,
      student_id: r.studentId,
      student_name: r.studentName,
      status: r.status,
      confidence: r.confidence || 1.0,
      detected_response: r.detectedResponse || null
    }));

    const { error: recordsError } = await supabase
      .from('attendance_records')
      .insert(recordInserts);

    if (recordsError) {
      logToFile('❌ Attendance records insert failed', { sessionId, error: recordsError.message, replacing: Boolean(existingSession) });
      throw new Error(existingSession
        ? `Could not save the correction; the day on file is unchanged: ${recordsError.message}`
        : `Saved the day but not the students: ${recordsError.message}`);
    }

    if (existingSession) {
      if (oldRecordIds.length > 0) {
        const { error: deleteError } = await supabase
          .from('attendance_records')
          .delete()
          .in('id', oldRecordIds);
        if (deleteError) {
          // Take the new rows back out, so the day holds what was on file rather than both.
          await supabase
            .from('attendance_records')
            .delete()
            .in('id', recordInserts.map(r => r.id));
          throw new Error(`Could not save the correction; the day on file is unchanged: ${deleteError.message}`);
        }
      }

      await supabase
        .from('attendance_sessions')
        .update({
          ...counts,
          marking_method: sessionData.markingMethod || 'voice',
          was_manually_edited: true
        })
        .eq('id', sessionId);
    }

    logToFile('✅ Attendance saved to database', {
      sessionId,
      recordCount: recordInserts.length,
      replaced: Boolean(existingSession)
    });

    return { sessionId, replaced: Boolean(existingSession), summary };
  }

  /**
   * Generate caption for WhatsApp document message
   */
  static generateCaption(metadata, summary) {
    const className = metadata.section
      ? `${metadata.className} - ${metadata.section}`
      : metadata.className;

    const dateStr = AttendanceGeneratorService.formatDateForDisplay(metadata.date);

    const lines = [
      `📋 *Attendance - ${className}*`,
      `📅 ${dateStr}`,
      '',
      `✅ Present: ${summary?.present || 0}`,
      `❌ Absent: ${summary?.absent || 0}`,
      `📈 Attendance: ${summary?.attendancePercentage?.toFixed(0) || 0}%`,
      '',
      'Your attendance file is ready!'
    ];

    return lines.join('\n');
  }

  /**
   * Resend an existing attendance Excel
   * Used when user requests re-delivery
   */
  static async resendExcel(sessionId, phoneNumber) {
    try {
      const { data: session, error } = await supabase
        .from('attendance_sessions')
        .select(`
          id,
          excel_url,
          session_date,
          total_students,
          present_count,
          absent_count,
          student_lists(class_name, section)
        `)
        .eq('id', sessionId)
        .single();

      if (error || !session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.excel_url) {
        return { success: false, error: 'No Excel file found for this session' };
      }

      const metadata = {
        className: session.student_lists?.class_name || 'Unknown',
        section: session.student_lists?.section || null,
        date: session.session_date
      };

      const summary = {
        present: session.present_count,
        absent: session.absent_count,
        total: session.total_students,
        attendancePercentage: session.total_students > 0
          ? (session.present_count / session.total_students) * 100
          : 0
      };

      const caption = this.generateCaption(metadata, summary);
      const fileName = AttendanceGeneratorService.formatFileName(
        metadata.className,
        metadata.section,
        metadata.date
      );

      const result = await WhatsAppService.sendDocumentFromUrl(
        phoneNumber,
        session.excel_url,
        fileName,
        caption
      );

      return { success: result, sessionId };

    } catch (error) {
      logToFile('Resend Excel failed', { sessionId, error: error.message });
      return { success: false, error: error.message };
    }
  }
}

module.exports = AttendanceDeliveryService;
