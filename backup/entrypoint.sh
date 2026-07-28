#!/bin/bash
# Writes the cron schedule from BIGBRAIN_BACKUP_CRON_SCHEDULE and hands off to crond in the
# foreground (container's PID 1) — no immediate run on start, so a redeploy doesn't fire an
# extra unscheduled backup. Trigger one on demand with: docker exec bigbrain-backup /backup.sh
set -euo pipefail

echo "${BIGBRAIN_BACKUP_CRON_SCHEDULE} /backup.sh >> /proc/1/fd/1 2>&1" > /etc/crontabs/root
echo "backup: cron schedule '${BIGBRAIN_BACKUP_CRON_SCHEDULE}', starting crond"
exec crond -f -l 2
