import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ClipboardList } from 'lucide-react';
import PortalLayout from '../components/PortalLayout';
import LoadingState from '../components/LoadingState';
import EmptyState from '../components/EmptyState';
import ObservationRow from '../components/ObservationRow';
import { coach } from '../services/api';
import type { CoachObservation } from '../types/portal';

/**
 * One of the coach's teachers and the observations the coach made of them.
 * The server answers 404 for anyone not on this coach's roster, 403 for a
 * user who is not a coach, and 500 when it cannot load — each its own message.
 */
const CoachTeacherDetail = () => {
  const { id } = useParams<{ id: string }>();
  const [teacher, setTeacher] = useState<{ name: string; schoolName: string | null } | null>(null);
  const [observations, setObservations] = useState<CoachObservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<'denied' | 'notFound' | 'unavailable'>('notFound');

  useEffect(() => {
    let alive = true;
    if (!id) {
      setLoading(false);
      return;
    }
    coach.getTeacher(id)
      .then((d) => {
        if (!alive) return;
        setTeacher(d.teacher);
        setObservations(d.observations || []);
      })
      .catch((err) => {
        if (!alive) return;
        const status = err?.response?.status;
        setFailure(status === 403 ? 'denied' : status === 404 ? 'notFound' : 'unavailable');
        setTeacher(null);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [id]);

  return (
    <PortalLayout>
      <div className="container mx-auto px-4 sm:px-6 py-6 sm:py-8 max-w-7xl">
        <Link to="/portal/observe" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="w-4 h-4" />
          My observations
        </Link>

        {loading ? (
          <LoadingState type="list" count={2} />
        ) : !teacher ? (
          <section className="bg-white rounded-lg p-6 shadow-sm border border-border">
            <p className="text-muted-foreground">
              {failure === 'denied'
                ? 'This area is for coaches.'
                : failure === 'unavailable'
                  ? "This teacher's observations aren't available right now. Please try again later."
                  : "This teacher isn't on your list."}
            </p>
          </section>
        ) : (
          <>
            <header className="mb-8">
              <h1 className="text-3xl sm:text-4xl font-light mb-2">{teacher.name}</h1>
              {teacher.schoolName && <p className="text-muted-foreground">{teacher.schoolName}</p>}
            </header>

            <section className="bg-white rounded-lg shadow-sm border border-border overflow-hidden">
              <div className="p-6 pb-3 flex items-center gap-2">
                <ClipboardList className="w-5 h-5 text-accent" />
                <h2 className="text-lg font-medium">Past observations</h2>
                <span className="text-sm text-muted-foreground">({observations.length})</span>
              </div>
              {observations.length === 0 ? (
                <EmptyState
                  icon={ClipboardList}
                  title="No observations yet"
                  description="When you observe this teacher with /observe, the visit appears here."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {observations.map((o) => <ObservationRow key={o.id} observation={o} hideTeacher />)}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </PortalLayout>
  );
};

export default CoachTeacherDetail;
