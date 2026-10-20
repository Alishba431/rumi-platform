import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, ClipboardList, CheckCircle2, Users, ChevronRight, Loader2, Send } from 'lucide-react';
import PortalLayout from '../components/PortalLayout';
import LoadingState from '../components/LoadingState';
import ObservationRow from '../components/ObservationRow';
import { formatDay } from '../lib/observations';
import { Badge } from '@/components/ui/badge';
import { coach } from '../services/api';
import type { CoachObservationsData, CoachTeacher } from '../types/portal';

/**
 * The coach's view — "My observations". Upcoming and overdue visits, what is
 * waiting on the coach (a form to check, a debrief to do, a report to send),
 * reports on their way to the teacher, the finished observations (the teacher
 * has the report), and their teachers. A failed load shows the error state,
 * never "Nothing waiting". Read-only: recording,
 * debriefing and sending happen in chat with /observe.
 */

const Section = ({ icon: Icon, title, count, children }: {
  icon: typeof CalendarDays; title: string; count?: number; children: ReactNode;
}) => (
  <section className="bg-white rounded-lg shadow-sm border border-border overflow-hidden">
    <div className="p-6 pb-3 flex items-center gap-2">
      <Icon className="w-5 h-5 text-accent" />
      <h2 className="text-lg font-medium">{title}</h2>
      {count !== undefined && <span className="text-sm text-muted-foreground">({count})</span>}
    </div>
    {children}
  </section>
);

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="px-6 pb-6 text-muted-foreground">{children}</p>
);

const CoachObservations = () => {
  const [data, setData] = useState<CoachObservationsData | null>(null);
  const [teachers, setTeachers] = useState<CoachTeacher[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([coach.getObservations(), coach.getTeachers().catch(() => ({ teachers: [] }))])
      .then(([o, t]) => {
        if (!alive) return;
        setData(o.observations);
        setTeachers(t.teachers || []);
      })
      .catch((err) => {
        if (!alive) return;
        if (err?.response?.status === 403) setDenied(true);
        setData(null);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const waiting = data ? [...data.waiting.form, ...data.waiting.debrief, ...data.waiting.report] : [];
  const delivering = data?.delivering ?? [];

  return (
    <PortalLayout>
      <div className="container mx-auto px-4 sm:px-6 py-6 sm:py-8 max-w-7xl">
        <header className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-light mb-2">My observations</h1>
          <p className="text-muted-foreground">
            Your visits, what is waiting on you, and your teachers. To record, debrief or send a report, send /observe to Rumi in chat.
          </p>
        </header>

        {loading ? (
          <LoadingState type="list" count={3} />
        ) : denied ? (
          <section className="bg-white rounded-lg p-6 shadow-sm border border-border">
            <p className="text-muted-foreground">This area is for coaches.</p>
          </section>
        ) : !data ? (
          <section className="bg-white rounded-lg p-6 shadow-sm border border-border">
            <p className="text-muted-foreground">Your observations aren't available right now. Please try again later.</p>
          </section>
        ) : (
          <div className="space-y-8">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-white rounded-lg p-4 shadow-sm border border-border">
                <div className="text-sm text-muted-foreground mb-1">Upcoming visits</div>
                <div className="text-2xl font-semibold">{data.upcoming.length}</div>
              </div>
              <div className="bg-white rounded-lg p-4 shadow-sm border border-border">
                <div className="text-sm text-muted-foreground mb-1">Waiting on you</div>
                <div className="text-2xl font-semibold">{waiting.length}</div>
              </div>
              <div className="bg-white rounded-lg p-4 shadow-sm border border-border">
                <div className="text-sm text-muted-foreground mb-1">Completed</div>
                <div className="text-2xl font-semibold">{data.completed.length}</div>
              </div>
            </div>

            <Section icon={CalendarDays} title="Upcoming visits" count={data.upcoming.length}>
              {data.upcoming.length === 0 ? (
                <Empty>No visits scheduled. Schedule one with /observe.</Empty>
              ) : (
                <ul className="divide-y divide-border">
                  {data.upcoming.map((v) => (
                    <li key={v.id} className="flex items-center justify-between gap-4 px-6 py-4">
                      <div className="min-w-0">
                        <div className="font-medium truncate">{v.teacherName || 'Teacher'}</div>
                        <div className="text-sm text-muted-foreground truncate">
                          {[formatDay(v.scheduledFor), v.scheduledSlot, v.schoolName].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                      {v.overdue && <Badge variant="destructive" className="shrink-0">Overdue</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section icon={ClipboardList} title="Waiting on you" count={waiting.length}>
              {waiting.length === 0 ? (
                <Empty>Nothing waiting. You're up to date.</Empty>
              ) : (
                <ul className="divide-y divide-border">
                  {waiting.map((o) => <ObservationRow key={o.id} observation={o} />)}
                </ul>
              )}
            </Section>

            {delivering.length > 0 && (
              <Section icon={Send} title="On its way to the teacher" count={delivering.length}>
                <ul className="divide-y divide-border">
                  {delivering.map((o) => <ObservationRow key={o.id} observation={o} />)}
                </ul>
              </Section>
            )}

            {data.inProgress.length > 0 && (
              <Section icon={Loader2} title="Being prepared" count={data.inProgress.length}>
                <ul className="divide-y divide-border">
                  {data.inProgress.map((o) => <ObservationRow key={o.id} observation={o} />)}
                </ul>
              </Section>
            )}

            <Section icon={CheckCircle2} title="Completed" count={data.completed.length}>
              {data.completed.length === 0 ? (
                <Empty>No completed observations yet.</Empty>
              ) : (
                <ul className="divide-y divide-border">
                  {data.completed.map((o) => <ObservationRow key={o.id} observation={o} />)}
                </ul>
              )}
            </Section>

            <Section icon={Users} title="My teachers" count={teachers.length}>
              {teachers.length === 0 ? (
                <Empty>No teachers yet. Ask your administrator to assign you a school.</Empty>
              ) : (
                <ul className="divide-y divide-border">
                  {teachers.map((t) => (
                    <li key={t.id}>
                      <Link
                        to={`/portal/observe/teacher/${encodeURIComponent(t.id)}`}
                        className="flex items-center justify-between gap-4 px-6 py-4 hover:bg-muted/50 transition-colors"
                      >
                        <div className="min-w-0">
                          <div className="font-medium truncate">{t.name}</div>
                          <div className="text-sm text-muted-foreground truncate">
                            {[
                              t.schoolName,
                              `${t.observationCount} observation${t.observationCount === 1 ? '' : 's'}`,
                              t.lastObservedAt ? `last ${formatDay(t.lastObservedAt)}` : null,
                            ].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        )}
      </div>
    </PortalLayout>
  );
};

export default CoachObservations;
