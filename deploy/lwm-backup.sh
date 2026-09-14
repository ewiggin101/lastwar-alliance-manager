#!/usr/bin/env bash
# Everything lwm-backup.timer does, in order, as root:
#
#   1. DB snapshot     backup.sh -> backups/alliance_<ts>.db      (sqlite3 .backup)
#   2. System bundle   backups/lwm-system.tgz                     (config, no secrets)
#   3. Userdata dump   sqlite3 .dump -> git commit + push          (private GitHub repo)
#
# backups/ is mirrored to the NAS by nas-backup.timer, so 1 and 2 land there
# within two hours. 3 is what puts the data itself on GitHub, diffable.
#
# Secrets never enter any of these outputs. The bundle carries a manifest of
# env var NAMES and which Proton Pass item refills each; the .env files
# themselves are excluded and the script refuses to write a bundle that
# contains one.
set -uo pipefail

LWM_DIR=/home/ubuntu/lastwar-alliance-manager
BACKUP_DIR="$LWM_DIR/backups"
DB="$LWM_DIR/data/alliance.db"
DATA_REPO=/home/ubuntu/lwm-data          # clone of git@github.com:ewiggin101/lwm-data
DATA_USER=ubuntu                          # owns the clone and the deploy key
RETENTION_DAYS=30

log() { echo "$(date -Is) [lwm-backup] $*"; }
rc=0

# ---- 1. DB snapshot ---------------------------------------------------------
if DATABASE_PATH="$DB" bash "$LWM_DIR/backup.sh" "$BACKUP_DIR" "$RETENTION_DAYS"; then
  log "snapshot OK"
else
  rc=1; log "snapshot FAILED"
fi

# ---- 2. System bundle -------------------------------------------------------
stage=$(mktemp -d)
bundle="$stage/lwm-system"
mkdir -p "$bundle"

# Copy each path if present, preserving its absolute layout under the bundle
# so a restore is `tar -C / -x` plus the secrets step.
copy() {
  local p; for p in "$@"; do
    [ -e "$p" ] || { log "bundle: missing $p, skipped"; continue; }
    mkdir -p "$bundle$(dirname "$p")" && cp -a "$p" "$bundle$p"
  done
}
copy "$LWM_DIR/docker-compose.yml" "$LWM_DIR/backup.sh" "$LWM_DIR/deploy" \
     /opt/bots/docker-compose.yml \
     /etc/systemd/system/lwm-backup.service /etc/systemd/system/lwm-backup.timer \
     /etc/systemd/system/nas-backup.service /etc/systemd/system/nas-backup.timer \
     /etc/nas-backup.d /etc/nas-backup.conf /usr/local/bin/nas-backup.sh

# Env manifest: names only. Values live in Proton Pass; see deploy/RESTORE.md.
{
  echo "# Env files on this host and the variables each carries -- NAMES ONLY."
  echo "# Refill from Proton Pass per deploy/RESTORE.md. Generated $(date -Is)."
  for f in "$LWM_DIR/.env" /opt/bots/*.env; do
    [ -f "$f" ] || continue
    echo; echo "$f"
    grep -v '^\s*#' "$f" | grep -oE '^[A-Za-z_][A-Za-z0-9_]*' | sed 's/^/  /'
  done
} > "$bundle/env-manifest.txt"

# Refuse to ship anything that looks like a secret.
if leaked=$(find "$bundle" -type f \( -name '.env' -o -name '*.env' -o -name '*.pass' -o -name 'id_*' -o -name '*_deploy' \) | head); [ -n "$leaked" ]; then
  rc=1; log "bundle REFUSED, secret-looking files staged: $leaked"
else
  if tar -czf "$BACKUP_DIR/lwm-system.tgz" -C "$stage" lwm-system; then
    log "bundle OK -> $BACKUP_DIR/lwm-system.tgz ($(du -h "$BACKUP_DIR/lwm-system.tgz" | cut -f1))"
  else
    rc=1; log "bundle FAILED"
  fi
fi
rm -rf "$stage"

# ---- 3. Userdata dump -> GitHub --------------------------------------------
if [ -d "$DATA_REPO/.git" ]; then
  dump="$DATA_REPO/alliance.sql"
  # .dump runs inside one read transaction, so it is consistent against the
  # live app. Output order is rowid order, which keeps diffs append-shaped.
  # login_sessions is an audit log of who logged in from which IP/browser:
  # no restore value, the most personal rows in the DB, so its schema goes
  # to GitHub but its rows do not. (The NAS .db snapshots keep everything.)
  if sqlite3 "$DB" .dump | grep -v '^INSERT INTO login_sessions ' > "$dump.tmp" && [ -s "$dump.tmp" ]; then
    mv "$dump.tmp" "$dump"
    chown "$DATA_USER:$DATA_USER" "$dump"
    if sudo -u "$DATA_USER" git -C "$DATA_REPO" diff --quiet -- alliance.sql && \
       ! sudo -u "$DATA_USER" git -C "$DATA_REPO" status --porcelain | grep -q .; then
      log "userdata: no change since last push"
    else
      if sudo -u "$DATA_USER" git -C "$DATA_REPO" add -A && \
         sudo -u "$DATA_USER" git -C "$DATA_REPO" commit -q -m "snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ)" && \
         sudo -u "$DATA_USER" git -C "$DATA_REPO" push -q; then
        log "userdata: pushed $(sudo -u "$DATA_USER" git -C "$DATA_REPO" rev-parse --short HEAD)"
      else
        rc=1; log "userdata: commit/push FAILED"
      fi
    fi
  else
    rc=1; rm -f "$dump.tmp"; log "userdata: dump FAILED"
  fi
else
  log "userdata: $DATA_REPO is not a git clone, skipped (see deploy/RESTORE.md)"
fi

[ $rc -eq 0 ] && log "all steps OK" || log "completed with errors"
exit $rc
