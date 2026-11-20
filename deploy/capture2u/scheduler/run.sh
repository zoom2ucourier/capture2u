#!/bin/bash
set -u

state_dir=/var/lib/capture2u
mkdir -p "$state_dir"

ran_today() { [ "$(cat "$state_dir/$1" 2>/dev/null)" = "$(date -u +%F)" ]; }
mark_today() { date -u +%F > "$state_dir/$1"; }
due() { [ "$(date -u +%H:%M)" \> "$1" ] || [ "$(date -u +%H:%M)" = "$1" ]; }

echo "[$(date -u +%FT%TZ)] capture2u scheduler started (backup ${BACKUP_AT_UTC} UTC, retention ${RETENTION_AT_UTC} UTC)"

last_upkeep=""
while true; do
	minute=$(date -u +%M)
	slot="$(date -u +%F%H)$((10#$minute / 15))"
	if [ "$slot" != "$last_upkeep" ]; then
		last_upkeep="$slot"
		call-cron.sh /api/cron/finalize-stale-desktop-segments 120 || true
		call-cron.sh /api/cron/recover-failed-video-processing 120 || true
	fi

	if due "$BACKUP_AT_UTC" && ! ran_today backup; then
		if backup.sh; then mark_today backup; else echo "[$(date -u +%FT%TZ)] BACKUP FAILED"; sleep 600; fi
	fi

	if due "$RETENTION_AT_UTC" && ! ran_today retention; then
		if call-cron.sh /api/cron/capture2u-retention 1800; then mark_today retention; else echo "[$(date -u +%FT%TZ)] RETENTION RUN FAILED"; sleep 600; fi
	fi

	sleep 30
done
