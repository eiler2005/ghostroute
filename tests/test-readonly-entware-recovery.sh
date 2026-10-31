#!/bin/sh
# Exercise the boot decisions and real archive validation without root mounts.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
FIXTURE=$(mktemp -d)
trap 'rm -rf "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/seed/etc/sing-box" "$FIXTURE/seed/var/cache/dnscrypt-proxy"
printf '%s\n' '{"outbounds":[{"tag":"sensitive-out"}]}' >"$FIXTURE/seed/etc/sing-box/config.json"
printf cached >"$FIXTURE/seed/var/cache/dnscrypt-proxy/resolvers.md"
tar -czf "$FIXTURE/good.tgz" -C "$FIXTURE/seed" etc var/cache/dnscrypt-proxy

for scenario in disabled writable other-volume existing-ram cold-mount fallback invalid-archive unexpected-path; do
  (
    CASE_DIR="$FIXTURE/$scenario"
    mkdir -p "$CASE_DIR"
    GHOSTROUTE_RO_RECOVERY_LIBRARY_ONLY=1
    . "$ROOT/modules/recovery-verification/router/readonly-entware-recovery"
    STATE="$CASE_DIR/ram"
    LOCKDIR="$CASE_DIR/lock"
    CONFIG="$CASE_DIR/config"
    ARCHIVE="$FIXTURE/good.tgz"
    UUID=deadbeef
    MOUNTPOINT=/tmp/mnt/fixture
    ENABLED=1
    MODE=ro
    OBSERVED_UUID=$UUID
    printf '%s\n' ENABLED=1 "UUID=$UUID" "MOUNTPOINT=$MOUNTPOINT" "ARCHIVE=$ARCHIVE" >"$CONFIG"
    log() { :; }
    get_uuid() { printf '%s\n' "$OBSERVED_UUID"; }
    mount_record() { [ ! -f "$CASE_DIR/mounted" ] || printf '/dev/fixture ext4 %s\n' "$MODE"; }
    find_device() { echo /dev/fixture; }
    device_ro() { echo 1; }
    mount_readonly() { : >"$CASE_DIR/mounted"; echo mount >>"$CASE_DIR/mutations"; }
    ensure_opt_link() { :; }
    targets_present() { :; }
    ram_bound() { [ -f "$CASE_DIR/binds/$1" ]; }
    bind_directory() {
      rel=${2#/opt/}
      mkdir -p "$CASE_DIR/binds/$(dirname "$rel")"
      : >"$CASE_DIR/binds/$rel"
      echo bind >>"$CASE_DIR/mutations"
    }
    start_entware() { echo start >>"$CASE_DIR/service-starts"; }
    [ "$scenario" = fallback ] || : >"$CASE_DIR/mounted"
    case "$scenario" in
      disabled)
        rm "$CONFIG"
        main prepare >/dev/null
        [ ! -e "$CASE_DIR/mutations" ]
        ;;
      writable)
        MODE=rw
        prepare_inner
        [ ! -e "$CASE_DIR/mutations" ]
        ;;
      other-volume)
        OBSERVED_UUID=feedbeef
        prepare_inner
        [ ! -e "$CASE_DIR/mutations" ]
        ;;
      existing-ram)
        for rel in etc var/run var/log var/cache/dnscrypt-proxy tmp; do
          mkdir -p "$CASE_DIR/binds/$(dirname "$rel")"; : >"$CASE_DIR/binds/$rel"
        done
        prepare_inner; prepare_inner
        [ ! -e "$CASE_DIR/mutations" ]
        [ ! -e "$CASE_DIR/service-starts" ]
        ;;
      cold-mount)
        prepare_inner
        [ "$(wc -l <"$CASE_DIR/mutations" | tr -d ' ')" = 5 ]
        prepare_inner
        [ "$(wc -l <"$CASE_DIR/mutations" | tr -d ' ')" = 5 ]
        [ -f "$STATE/seed.$$/etc/sing-box/config.json" ]
        [ -f "$STATE/seed.$$/var/cache/dnscrypt-proxy/resolvers.md" ]
        [ -z "$(ls -A "$STATE/seed.$$/var/run")" ]
        [ ! -e "$CASE_DIR/service-starts" ]
        ;;
      fallback)
        main boot
        [ "$(wc -l <"$CASE_DIR/mutations" | tr -d ' ')" = 6 ]
        [ "$(wc -l <"$CASE_DIR/service-starts" | tr -d ' ')" = 1 ]
        [ ! -e "$STATE/start-needed" ]
        rmdir "$LOCKDIR"
        main boot
        [ "$(wc -l <"$CASE_DIR/service-starts" | tr -d ' ')" = 1 ]
        ;;
      invalid-archive)
        ARCHIVE="$CASE_DIR/broken.tgz"; printf broken >"$ARCHIVE"
        if prepare_inner; then exit 1; fi
        [ ! -e "$CASE_DIR/mutations" ]
        ;;
      unexpected-path)
        printf unexpected >"$CASE_DIR/unexpected"
        tar -czf "$CASE_DIR/bad-path.tgz" -C "$CASE_DIR" unexpected
        ARCHIVE="$CASE_DIR/bad-path.tgz"
        if prepare_inner; then exit 1; fi
        [ ! -e "$CASE_DIR/mutations" ]
        ;;
    esac
  )
done
(
  GHOSTROUTE_RO_RECOVERY_LIBRARY_ONLY=1
  . "$ROOT/modules/recovery-verification/router/readonly-entware-recovery"
  UUID=deadbeef
  partition_nodes() { printf '%s\n' /dev/sdz1 /dev/sdz2; }
  is_block_device() { return 0; }
  get_uuid() { [ "$1" != /dev/sdz2 ] || echo deadbeef; }
  [ "$(find_device)" = /dev/sdz2 ]
  BLOCK_ROOT="$FIXTURE/legacy-sys/block"
  mkdir -p "$BLOCK_ROOT/sdz"
  echo 1 >"$BLOCK_ROOT/sdz/ro"
  [ "$(device_ro /dev/sdz2)" = 1 ]
  opt_link_target_ok tmp/opt
  opt_link_target_ok /tmp/opt
  if opt_link_target_ok /tmp/other; then exit 1; fi
)
echo "read-only Entware recovery: 8 boot fixtures, legacy sysfs and relative opt link passed"
