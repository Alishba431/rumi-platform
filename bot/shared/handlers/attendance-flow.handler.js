/**
 * Attendance Flow Handler
 * Handles WhatsApp Flow responses for attendance setup and marking
 *
 * Created: January 24, 2026
 * Updated: January 26, 2026 (Auto-compute academic year)
 */

const supabase = require('../config/supabase');
const StudentListService = require('../services/student-list.service');
const AttendanceGeneratorService = require('../services/attendance-generator.service');
const { logToFile } = require('../utils/logger');
const AttendanceDates = require('../services/attendance-dates');

/**
 * The current academic year ("YYYY-YYYY"); the start month is configurable
 * (ATTENDANCE_ACADEMIC_YEAR_START_MONTH, default April) — see attendance-dates.
 *
 * @returns {string} Academic year in format "YYYY-YYYY"
 */
function getCurrentAcademicYear() {
  return AttendanceDates.academicYear();
}

// Flow IDs - configurable via env for staging vs production
const ATTENDANCE_SETUP_FLOW_ID = process.env.ATTENDANCE_SETUP_FLOW_ID || '';
const ATTENDANCE_MARKING_FLOW_ID = process.env.ATTENDANCE_MARKING_FLOW_ID || '';

// The marking token's second segment is a class's list id, or this word for a head
// teacher's staff attendance (userId:staff:date:sessionType:encodedSchoolName).
const STAFF_TARGET = 'staff';

class AttendanceFlowHandler {
  /**
   * Parse setup flow response into structured data
   *
   * @param {Object} responseJson - Parsed response_json from flow
   * @returns {Object|null} Parsed setup data or null if invalid
   */
  static parseSetupFlowResponse(responseJson) {
    if (!responseJson) {
      return null;
    }

    try {
      const className = responseJson.class_name?.trim();
      const section = responseJson.section?.trim() || null;
      // Auto-compute academic year instead of expecting from flow
      const academicYear = getCurrentAcademicYear();
      const attendanceFrequency = responseJson.attendance_frequency;
      const studentList = responseJson.student_list?.trim();

      // Validate required fields (academic year no longer from flow)
      if (!className || !attendanceFrequency || !studentList) {
        logToFile('Missing required fields in setup flow', { responseJson });
        return null;
      }

      logToFile('📅 Academic year auto-computed', { academicYear });

      return {
        className,
        section,
        academicYear,
        attendanceFrequency,
        studentList
      };
    } catch (error) {
      logToFile('Error parsing setup flow response', { error: error.message });
      return null;
    }
  }

  /**
   * Parse marking flow response into structured data
   *
   * @param {Object} responseJson - Parsed response_json from flow
   * @returns {Object|null} Parsed marking data or null if invalid
   */
  static parseMarkingFlowResponse(responseJson) {
    if (!responseJson) {
      return null;
    }

    try {
      const absentStudentIds = responseJson.absent_students || [];
      // Optional: older Flow versions and surfaces without a leave field send none.
      const leaveStudentIds = responseJson.leave_students || [];
      const className = responseJson.class_name;
      const dateDisplay = responseJson.date_display;
      const sessionType = responseJson.session_type || 'Full Day';

      return {
        absentStudentIds,
        leaveStudentIds,
        className,
        dateDisplay,
        sessionType,
        everyonePresent: absentStudentIds.length === 0 && leaveStudentIds.length === 0
      };
    } catch (error) {
      logToFile('Error parsing marking flow response', { error: error.message });
      return null;
    }
  }

  /**
   * Validate setup data
   *
   * @param {Object} data - Parsed setup data
   * @returns {{valid: boolean, error?: string}}
   */
  static validateSetupData(data) {
    if (!data.className || data.className.trim() === '') {
      return { valid: false, error: 'Class name is required' };
    }

    // Validate academic year format (YYYY-YYYY)
    const yearMatch = data.academicYear?.match(/^(\d{4})-(\d{4})$/);
    if (!yearMatch) {
      return { valid: false, error: 'Invalid academic year format' };
    }

    const startYear = parseInt(yearMatch[1], 10);
    const endYear = parseInt(yearMatch[2], 10);
    if (endYear !== startYear + 1) {
      return { valid: false, error: 'Academic year must be consecutive years' };
    }

    if (!data.studentList || data.studentList.trim() === '') {
      return { valid: false, error: 'Student list is required' };
    }

    return { valid: true };
  }

  /**
   * Build attendance records by exception: the absent and the on-leave are named,
   * everyone else is present. Someone in both lists is on leave — the more specific
   * statement, and counting them twice would corrupt the tallies.
   *
   * @param {Array} allStudents - Everyone on the roster (students, or staff)
   * @param {Array} absentIds - IDs of absent people
   * @param {Array} [leaveIds] - IDs of people on approved leave
   * @returns {Array} Attendance records with status
   */
  static buildAttendanceRecords(allStudents, absentIds, leaveIds = []) {
    const leaveSet = new Set(leaveIds || []);
    const absentSet = new Set((absentIds || []).filter(id => !leaveSet.has(id)));

    return allStudents.map(student => ({
      studentId: student.id,
      studentName: student.student_name,
      fatherName: student.father_name,
      rollNumber: student.roll_number,
      status: leaveSet.has(student.id) ? 'leave' : absentSet.has(student.id) ? 'absent' : 'present',
      confidence: 1.0 // Manual marking = 100% confidence
    }));
  }

  /**
   * Generate confirmation message for completed attendance
   *
   * @param {string} className - Class name with section
   * @param {Object} stats - Attendance statistics
   * @returns {string} Formatted message
   */
  static generateConfirmationMessage(className, stats, { subject = 'class' } = {}) {
    // The day's rate follows the register's rule: for staff, approved leave is
    // excused (present ÷ present + absent); for a class it is present ÷ everyone.
    let rate = stats.attendanceRate;
    if (subject === 'staff') {
      const worked = (stats.present || 0) + (stats.absent || 0);
      const pct = worked ? (stats.present / worked) * 100 : 0;
      rate = pct === 100 || pct === 0 ? `${pct}%` : `${pct.toFixed(2)}%`;
    }

    const lines = [
      `*Attendance Recorded*`,
      ``,
      subject === 'staff' ? `School: ${className}` : `Class: ${className}`,
      `Total: ${stats.total}`,
      `Present: ${stats.present}`,
      `Absent: ${stats.absent}`,
      `On leave: ${stats.leave || 0}`,
      `Attendance Rate: ${rate}`,
      ``,
      `Your Excel file is being generated...`
    ];

    return lines.join('\n');
  }

  /**
   * Handle setup flow submission
   *
   * @param {Object} message - WhatsApp message object
   * @param {string} phoneNumber - User's phone number
   * @param {string} userId - User's database ID
   * @returns {Promise<{success: boolean, listId?: string, error?: string}>}
   */
  static async handleSetupFlowSubmission(message, phoneNumber, userId) {
    try {
      // Parse response
      const responseJson = JSON.parse(message.interactive?.nfm_reply?.response_json || '{}');
      const data = this.parseSetupFlowResponse(responseJson);

      if (!data) {
        return { success: false, error: 'Invalid flow response' };
      }

      // Validate
      const validation = this.validateSetupData(data);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      // Create student list
      const { data: listData, error: listError } = await StudentListService.createStudentList(userId, {
        className: data.className,
        section: data.section,
        academicYear: data.academicYear,
        attendanceFrequency: data.attendanceFrequency
      });

      if (listError) {
        return { success: false, error: 'Failed to create class' };
      }

      // Parse and add students
      const parsedStudents = StudentListService.parseStudentText(data.studentList);

      // Check if parsing returned any students
      if (!parsedStudents || parsedStudents.length === 0) {
        logToFile('❌ No students parsed from input', {
          studentListInput: data.studentList,
          parsedCount: 0
        });
        return { success: false, error: 'Could not parse any student names. Please enter one student per line (e.g., "Ahmed Khan" or "Zara s/o Abdul")' };
      }

      logToFile('Parsed students', { count: parsedStudents.length, sample: parsedStudents[0] });

      const { data: studentsData, error: studentsError } = await StudentListService.addStudentsToList(
        listData.id,
        parsedStudents
      );

      if (studentsError) {
        logToFile('❌ Failed to add students to database', {
          error: studentsError.message,
          listId: listData.id,
          studentCount: parsedStudents.length
        });
        return { success: false, error: `Failed to add students: ${studentsError.message}` };
      }

      logToFile('Attendance setup completed', {
        userId,
        listId: listData.id,
        className: data.className,
        studentCount: studentsData.length
      });

      return {
        success: true,
        listId: listData.id,
        className: data.className,
        section: data.section,
        studentCount: studentsData.length
      };
    } catch (error) {
      logToFile('Error handling setup flow', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle marking flow submission
   *
   * @param {Object} message - WhatsApp message object
   * @param {string} phoneNumber - User's phone number
   * @param {string} userId - User's database ID
   * @param {string} listId - Student list ID
   * @param {Date} sessionDate - Date of attendance
   * @param {string} sessionType - 'full_day', 'morning', or 'afternoon'
   * @returns {Promise<{success: boolean, records?: Array, stats?: Object, error?: string}>}
   */
  static async handleMarkingFlowSubmission(message, phoneNumber, userId, listId, sessionDate, sessionType) {
    try {
      // Parse response
      const responseJson = JSON.parse(message.interactive?.nfm_reply?.response_json || '{}');
      const data = this.parseMarkingFlowResponse(responseJson);

      if (!data) {
        return { success: false, error: 'Invalid flow response' };
      }

      // Get everyone on the roster: the school's staff, or the class's students
      let allStudents;
      if (listId === STAFF_TARGET) {
        const StaffAttendanceService = require('../services/staff-attendance.service');
        const marker = await StaffAttendanceService.loadUser(userId);
        if (!StaffAttendanceService.isHeadTeacher(marker) || !marker.school_id) {
          return { success: false, error: 'Staff attendance is marked by a head teacher linked to a school.' };
        }
        const staff = await StaffAttendanceService.loadStaffRoster(marker.school_id, userId);
        allStudents = staff.map(s => ({ id: s.id, student_name: StaffAttendanceService.personName(s) }));
      } else {
        const { data: students, error: studentsError } = await StudentListService.getStudentsByList(listId);
        if (studentsError || !students) {
          return { success: false, error: 'Failed to fetch students' };
        }
        allStudents = students;
      }

      // Build attendance records
      const records = this.buildAttendanceRecords(allStudents, data.absentStudentIds, data.leaveStudentIds);

      // Calculate stats
      const stats = AttendanceGeneratorService.calculateSummaryStats(records);

      logToFile('Attendance marking completed', {
        userId,
        listId,
        total: stats.total,
        present: stats.present,
        absent: stats.absent,
        leave: stats.leave
      });

      return {
        success: true,
        records,
        stats,
        everyonePresent: data.everyonePresent
      };
    } catch (error) {
      logToFile('Error handling marking flow', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if a flow ID is an attendance flow
   *
   * @param {string} flowId - Flow ID to check
   * @returns {string|null} 'setup', 'marking', or null
   */
  static getAttendanceFlowType(flowId) {
    if (flowId === ATTENDANCE_SETUP_FLOW_ID) {
      return 'setup';
    }
    if (flowId === ATTENDANCE_MARKING_FLOW_ID) {
      return 'marking';
    }
    return null;
  }
}

AttendanceFlowHandler.STAFF_TARGET = STAFF_TARGET;

module.exports = AttendanceFlowHandler;
