import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  automation,
  bulk,
  jobs,
  whatsapp,
  type AutomationProfile,
  type BulkOperation,
  type JobRow,
  type WhatsAppAccount,
} from '../../api/client';
import { useAuth } from '../../auth-context';
import { errorMessage, useToast } from '../../components/ui';

const OPERATIONS: Array<{ value: BulkOperation; label: string; needsProfile?: boolean }> = [
  { value: 'ENABLE_AUTOMATION', label: 'Turn automation on' },
  { value: 'DISABLE_AUTOMATION', label: 'Turn automation off' },
  { value: 'ENABLE_AI', label: 'Turn AI answering on' },
  { value: 'DISABLE_AI', label: 'Turn AI answering off' },
  { value: 'ENABLE_MONITORING', label: 'Start monitoring' },
  { value: 'DISABLE_MONITORING', label: 'Stop monitoring' },
  { value: 'ASSIGN_AUTOMATION_PROFILE', label: 'Assign an automation profile', needsProfile: true },
  { value: 'CLEAR_AUTOMATION_PROFILE', label: 'Remove the automation profile' },
];

/**
 * One change, across thousands of groups.
 *
 * Deliberately two steps. **Preview** answers "how many groups am I about to change, and which
 * ones?" before anything moves; **Apply** queues a Job Center job with one item per group and hands
 * back its id. Nothing here writes thousands of rows inside a request, which is why the progress
 * below is real and a failure is attributable to a specific group rather than to "the batch".
 */
export function BulkActionsPage() {
  const { can } = useAuth();
  const toast = useToast();

  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([]);
  const [profiles, setProfiles] = useState<AutomationProfile[]>([]);
  const [operation, setOperation] = useState<BulkOperation>('ENABLE_AUTOMATION');
  const [accountId, setAccountId] = useState('');
  const [profileId, setProfileId] = useState('');

  const [preview, setPreview] = useState<{ total: number; sample: Array<{ id: string; name: string | null }> } | null>(
    null,
  );
  const [job, setJob] = useState<JobRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const poll = useRef<number | null>(null);
  const canRun = can('groups.bulk_update');

  useEffect(() => {
    void (async () => {
      try {
        const [accountList, profileList] = await Promise.all([whatsapp.overview(), automation.profiles()]);
        setAccounts(accountList.items);
        setProfiles(profileList.items);
        if (accountList.items[0]) setAccountId(accountList.items[0].id);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Could not load accounts.');
      }
    })();
  }, []);

  // A queued job finishes on the worker, not here; the page follows it until it stops moving.
  const follow = useCallback((id: string) => {
    if (poll.current) window.clearInterval(poll.current);
    poll.current = window.setInterval(async () => {
      try {
        const latest = await jobs.get(id);
        setJob(latest);
        const done = ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'];
        if (done.includes(latest.status) && poll.current) {
          window.clearInterval(poll.current);
          poll.current = null;
        }
      } catch {
        if (poll.current) window.clearInterval(poll.current);
        poll.current = null;
      }
    }, 1500);
  }, []);

  useEffect(() => () => {
    if (poll.current) window.clearInterval(poll.current);
  }, []);

  const request = () => ({
    operation,
    filter: accountId ? { channelAccountId: accountId } : undefined,
    targetId: operation === 'ASSIGN_AUTOMATION_PROFILE' ? profileId || undefined : undefined,
  });

  async function runPreview() {
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      setPreview(await bulk.preview(request()));
    } catch (failure) {
      toast.error(errorMessage(failure, 'That selection could not be previewed.'));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const queued = await bulk.apply(request());
      const started = await jobs.get(queued.jobId);
      setJob(started);
      follow(queued.jobId);
      toast.success(`Queued for ${queued.totalItems} group${queued.totalItems === 1 ? '' : 's'}.`);
    } catch (failure) {
      toast.error(errorMessage(failure, 'That change could not be started.'));
    } finally {
      setBusy(false);
    }
  }

  async function retryFailed() {
    if (!job) return;
    try {
      setJob(await jobs.retry(job.id));
      follow(job.id);
      toast.info('Retrying the groups that failed.');
    } catch (failure) {
      toast.error(errorMessage(failure, 'The failed items could not be retried.'));
    }
  }

  const needsProfile = OPERATIONS.find((entry) => entry.value === operation)?.needsProfile ?? false;

  return (
    <>
      <div className="page-head">
        <h1>Bulk actions</h1>
        <Link to="/automation" className="small">
          ← Rules
        </Link>
      </div>

      <p className="page-sub">
        Preview first. The count below is what will change, and it is resolved now rather than when
        the job runs, so the set cannot drift between reading it and starting it.
      </p>

      {error && <div className="alert">{error}</div>}

      <div className="card card-pad stack">
        <label>
          Do this
          <select
            value={operation}
            onChange={(event) => {
              setOperation(event.target.value as BulkOperation);
              setPreview(null);
            }}
          >
            {OPERATIONS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        {needsProfile && (
          <label>
            Profile
            <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
              <option value="">Choose a profile…</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label>
          To every active group on
          <select
            value={accountId}
            onChange={(event) => {
              setAccountId(event.target.value);
              setPreview(null);
            }}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} ({account.groupCount} groups)
              </option>
            ))}
          </select>
        </label>

        <div className="row">
          <button type="button" disabled={busy || !accountId} onClick={() => void runPreview()}>
            Preview
          </button>
          {canRun && preview && preview.total > 0 && (
            <button type="button" className="primary" disabled={busy} onClick={() => void apply()}>
              Apply to {preview.total} group{preview.total === 1 ? '' : 's'}
            </button>
          )}
        </div>
        {!canRun && <div className="muted small">You do not have permission to run bulk changes.</div>}
      </div>

      {preview && (
        <div className="card card-pad stack">
          <strong>
            {preview.total} group{preview.total === 1 ? '' : 's'} would change
          </strong>
          {preview.total === 0 ? (
            <div className="muted small">Nothing matches that selection.</div>
          ) : (
            <>
              <ul className="steps">
                {preview.sample.map((group) => (
                  <li key={group.id}>{group.name ?? group.id}</li>
                ))}
              </ul>
              {preview.total > preview.sample.length && (
                <div className="muted small">
                  …and {preview.total - preview.sample.length} more. Nothing has changed yet.
                </div>
              )}
            </>
          )}
        </div>
      )}

      {job && (
        <div className="card card-pad stack">
          <strong>{job.name}</strong>
          <div className="progress">
            {job.status === 'QUEUED' || job.status === 'RUNNING' ? (
              <span className="spinner" aria-hidden="true" />
            ) : null}
            <span>
              {job.completedItems} of {job.totalItems} done
              {job.failedItems > 0 ? `, ${job.failedItems} failed` : ''} — {job.status.toLowerCase().replace(/_/g, ' ')}
            </span>
          </div>
          {job.error && <div className="alert">{job.error}</div>}
          {job.failedItems > 0 && can('jobs.manage') && (
            <button type="button" onClick={() => void retryFailed()}>
              Retry the {job.failedItems} that failed
            </button>
          )}
          <div className="muted small">
            Progress is per group. Retrying re-runs only the groups that did not work, not the whole
            selection.
          </div>
        </div>
      )}
    </>
  );
}
