'use strict';
/**
 * Lesson quiz — what the teacher and the class are HANDED: the teacher's PDF
 * (rendered from the stored rows, each with its figure re-drawn as a vector)
 * and the message the teacher forwards to the class.
 *
 * Its own module because two steps need it: the generate step (first send) and
 * the hand-off (first send and every "resend the link"). Kept apart from both,
 * neither has to require the other for it. Lazy requires inside each function
 * keep the renderer, the figure engine and the PDF browser off the load path.
 */

const { logToFile } = require('../../utils/logger');
const { resolveUx } = require('../../config/ux-strings');

/**
 * The questions the teacher PDF sees: the stored rows, each with the vector
 * for its figure so the template can inline it above the stem. Best effort —
 * a figure that will not re-draw costs the PDF a picture, never the PDF.
 */
function withFigureSvgs(rows, questions, language) {
  const Figure = require('./transcript-quiz-figure');
  return rows.map((row, i) => {
    const authored = questions && questions[i];
    const spec = (row.media && row.media.figure) || (authored && authored.figure);
    if (!spec) return row;
    let svg = authored && authored.figureSvg;
    if (!svg) {
      try {
        svg = Figure.renderFigureSvg(spec, language);
      } catch (err) {
        logToFile('⚠️ transcript quiz: figure not re-drawn for the PDF', { index: i, error: err.message });
        return row;
      }
    }
    return { ...row, figureSvg: svg };
  });
}

// ─── messages ────────────────────────────────────────────────────────────────

/** "Teacher Rifat" / "استاد رفعت", or a language-appropriate "your teacher" when no name is stored. */
function teacherLabel(teacherName, language) {
  const name = String(teacherName || '').trim();
  const generic = /^(your teacher|teacher|آپ کے استاد)$/i.test(name);
  if (!name || generic) return resolveUx('tqYourTeacher', { language });
  return resolveUx('tqTeacherNamed', { language, params: { name } });
}

/**
 * The message a teacher forwards to the class, in the shape the join line
 * allows (`joinInvite` in video-quiz-share: `{kind, link, code, bot}`):
 *
 *   wa      a wa.me link that opens the bot's chat with the code already typed
 *           → tqStudentMessage (the link is all a child needs);
 *   matrix  a link to the bot's account plus the code to send there
 *           → tqStudentMessageJoin;
 *   code    no link this channel can open — the code and the bot's name
 *           → tqStudentMessageCode.
 *
 * A caller that still passes a bare `link` (and no invite) gets the wa.me form.
 */
function studentMessage({
  teacherName, topic, date, link = null, invite = null, language,
}) {
  // The message a teacher forwards to the class is text: a topic carrying TeX
  // maths reads "1/2", never "$\frac{1}{2}$" (quiz-math.js).
  const { mathForChat } = require('./quiz-math');
  const base = {
    teacher: teacherLabel(teacherName, language),
    topic: mathForChat(topic) || resolveUx('tqTodaysLesson', { language }),
    date,
  };
  const join = invite || (link ? { kind: 'wa', link } : null);
  if (!join) throw new Error('studentMessage: no join invite (neither invite nor link given)');
  if (join.kind === 'wa' && join.link) {
    return resolveUx('tqStudentMessage', { language, params: { ...base, link: join.link } });
  }
  if (join.kind === 'matrix' && join.link) {
    return resolveUx('tqStudentMessageJoin', {
      language, params: { ...base, link: join.link, code: join.code, bot: join.bot },
    });
  }
  return resolveUx('tqStudentMessageCode', { language, params: { ...base, code: join.code, bot: join.bot } });
}

function pdfFilename(topic) {
  const safe = String(topic || 'quiz').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'quiz';
  return `Quiz_${safe}.pdf`;
}

/**
 * THE DOCUMENT IS SINGLE-LANGUAGE, and the language is the QUIZ's.
 *
 * An earlier version gave the sheet two languages at once: the teacher's stored
 * preference for the labels, the quiz's language for the questions. It reads as
 * a defect — an English PDF with Urdu down its side — so both arguments are now
 * the quiz's language, which is the one chosen for this quiz and the one the
 * class will read. The stored preference still decides every WhatsApp message
 * around the document: the caption, the report promise, the nudge.
 *
 * Both parameters stay in the signature because the template still honours
 * them; passing them the same value is the decision, not a simplification.
 */
async function renderPdf({ quiz, questions, digest, teacherName, grade, lessonSummary, language, contentLanguage, date, link }) {
  const { htmlToPdf } = require('../../utils/html-to-pdf');
  const render = require('../../templates/transcript-quiz-teacher.template');
  const html = render({
    topic: quiz.topic, teacherName, grade, date, link, digest, questions, lessonSummary,
    language, contentLanguage: contentLanguage || quiz.language || language,
    quizSource: quiz.quiz_source || null,
  });
  const buffer = await htmlToPdf(html, {
    timeout: 45000,
    untrusted: true, // model-written content: no page script, no network
    pdfOptions: { format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } },
  });
  if (!buffer || !buffer.length) throw new Error('empty PDF');
  return buffer;
}

module.exports = {
  withFigureSvgs, teacherLabel, studentMessage, pdfFilename, renderPdf,
};
