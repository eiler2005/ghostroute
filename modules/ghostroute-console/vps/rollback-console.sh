#!/bin/sh
# Run on the Console VPS as root. Database restoration is deliberately separate.
set -eu
root=/opt/ghostroute-console
backup=${1:?Usage: rollback-console.sh /opt/ghostroute-console/rollback/<release>}
case "$backup" in "$root"/rollback/*) ;; *) echo 'Invalid Console backup directory' >&2; exit 1 ;; esac
backup=$(realpath "$backup")
case "$backup" in "$root"/rollback/*) ;; *) exit 1 ;; esac
image=$(cat "$backup/image-tag")
case "$image" in ghostroute-console:rollback-*) ;; *) echo 'Invalid rollback image' >&2; exit 1 ;; esac
archive="$backup/console-source.tar.gz"
if [ -f "$backup/previous-console-source.tar.gz" ]; then archive="$backup/previous-console-source.tar.gz"; fi
test -f "$archive"
docker image inspect "$image" >/dev/null
cd "$root/repo"
docker compose -f modules/ghostroute-console/vps/docker-compose.yml stop ghostroute-console
tar -xzf "$archive" -C "$root/repo"
if [ -f "$backup/previous.env" ]; then
  cp -p "$backup/previous.env" modules/ghostroute-console/vps/.env
fi
for file in policy-snapshot.local.json device-attribution.json device-attribution.local.json device-aliases.json; do
  if [ -f "$backup/$file" ]; then
    cp -p "$backup/$file" "$root/data/$file"
    chown 10000:10000 "$root/data/$file"
  fi
done
docker tag "$image" ghostroute-console:latest
docker compose -f modules/ghostroute-console/vps/docker-compose.yml up -d --no-build ghostroute-console
curl --fail --silent --retry 12 --retry-connrefused --retry-delay 2 http://127.0.0.1:3000/api/health >/dev/null
echo 'Previous Console image and configuration restored; verify public browser delivery separately.'
