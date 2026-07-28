import './BackupWarningModal.css';

interface BackupWarningModalProps {
  onDismiss: () => void;
}

/** Shown once per browser session (App.tsx tracks dismissal in sessionStorage) when GET
 *  /v1/whoami reports backupConfigured: false — docker-compose.yml's `backup` sidecar is running
 *  without real R2 credentials, so nothing is actually landing offsite (docs/spec.md §6.6). A
 *  reminder, not a blocker: dismissing doesn't fix anything, it just stops nagging until the next
 *  session, since the underlying fix (backup/README.md) happens outside this app entirely. */
export default function BackupWarningModal({ onDismiss }: BackupWarningModalProps) {
  return (
    <div className="backup-warning-overlay">
      <div className="backup-warning-modal">
        <h2>Offsite backup isn't configured</h2>
        <p>
          The backup service is deployed but has no real storage credentials yet, so nothing is
          currently landing offsite. See <code>backup/README.md</code> for setup.
        </p>
        <button onClick={onDismiss}>Got it</button>
      </div>
    </div>
  );
}
