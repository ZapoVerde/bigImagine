#!/bin/bash
# Writes the cron schedule from BIGBRAIN_BACKUP_CRON_SCHEDULE and hands off to crond in the
# foreground (container's PID 1) — no immediate run on start, so a redeploy doesn't fire an
# extra unscheduled backup. Trigger one on demand with: docker exec bigbrain-backup /backup.sh
set -euo pipefail

if [ "${BIGBRAIN_BACKUP_CONFIGURED:-false}" != "true" ]; then
  echo "backup: BIGBRAIN_BACKUP_CONFIGURED is not 'true' — no real R2 credentials yet, so this"
  echo "backup: container is idling instead of running backup.sh on a schedule against fake/"
  echo "backup: missing ones. Fill in the BIGBRAIN_BACKUP_* vars in .env (see .env.example),"
  echo "backup: set BIGBRAIN_BACKUP_CONFIGURED=true, and redeploy this service to start real"
  echo "backup: backups. See docs/bootstrap.md and backup/README.md."
  exec sleep infinity
fi

echo "${BIGBRAIN_BACKUP_CRON_SCHEDULE} /backup.sh >> /proc/1/fd/1 2>&1" > /etc/crontabs/root
echo "backup: cron schedule '${BIGBRAIN_BACKUP_CRON_SCHEDULE}', starting crond"
exec crond -f -l 2
