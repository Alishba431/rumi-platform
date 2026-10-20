import type { ObservationStage } from '../types/portal';

/** "12 Mar 2026" from an ISO date or timestamp; "—" when missing. */
export function formatDay(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : `${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * What the coach does next for an observation at this stage, or what it is
 * waiting on. "Done" only once the report has reached the teacher.
 */
export const STAGE_LABEL: Record<ObservationStage, string> = {
  form: 'Check the form',
  debrief: 'Do the debrief',
  report: 'Send the report',
  awaitingTeacher: 'Invite sent, waiting for the teacher',
  withReview: 'With the review team',
  inProgress: 'Being prepared',
  completed: 'Done',
};
