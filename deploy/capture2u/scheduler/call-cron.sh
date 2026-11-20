#!/bin/bash
set -u

path="$1"
max_time="${2:-120}"

response=$(curl -sS --max-time "$max_time" -w '\n%{http_code}' \
	-H "Authorization: Bearer ${CRON_SECRET}" \
	"${CAP_WEB_INTERNAL_URL}${path}" 2>&1)
status=$(printf '%s' "$response" | tail -n 1)
body=$(printf '%s' "$response" | sed '$d' | head -c 4000)

echo "[$(date -u +%FT%TZ)] ${path} -> ${status} ${body}"
[ "$status" = "200" ]
