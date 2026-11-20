#!/bin/bash
set -euo pipefail

stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
dump="$workdir/capture2u-$stamp.sql.gz"
encrypted="$dump.enc"

MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump \
	--host="$MYSQL_HOST" --user=root \
	--single-transaction --routines --triggers --no-tablespaces \
	cap | gzip -9 > "$dump"

openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
	-in "$dump" -out "$encrypted" \
	-pass env:BACKUP_ENCRYPTION_PASSPHRASE

key="mysql/$(basename "$encrypted")"
curl -sS --fail --max-time 900 \
	--aws-sigv4 "aws:amz:auto:s3" \
	--user "${BACKUP_R2_ACCESS_KEY_ID}:${BACKUP_R2_SECRET_ACCESS_KEY}" \
	-H "x-amz-content-sha256: UNSIGNED-PAYLOAD" \
	-T "$encrypted" \
	"${BACKUP_R2_ENDPOINT%/}/${BACKUP_R2_BUCKET}/${key}"

size=$(stat -c %s "$encrypted")
echo "[$(date -u +%FT%TZ)] backup uploaded: ${key} (${size} bytes)"
