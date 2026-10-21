#!/usr/bin/env bash
# Quidey database migrations: applies every migrations/NNN_*.sql that hasn't run yet, in order,
# and remembers what ran in the table schema_migrations.
#
#   sudo quidey-migrate status          # what ran, what is pending (changes nothing)
#   sudo quidey-migrate                 # apply everything pending
#   sudo quidey-migrate baseline 017    # mark 001..017 as applied WITHOUT running them
#
# Each file runs in ONE transaction together with its schema_migrations row: either the whole
# file is applied and recorded, or nothing is. The first error stops the run.
#
# On the server this script runs as root (via sudo) and switches users itself:
#   - reads the files as the app user (the app directory belongs to it),
#   - talks to Postgres as the superuser `postgres` (peer auth over the local socket).
# Install a root-owned copy, so the app user can't change what root executes:
#   sudo install -o root -g root -m 755 /srv/quidey/backend/scripts/migrate.sh /usr/local/sbin/quidey-migrate
#
# Run as a normal user (e.g. a dev machine), it reads the files directly and psql uses the usual
# PG* environment variables (PGUSER, PGPASSWORD, PGHOST, ...).
#
# Settings (environment variables, server defaults):
#   QUIDEY_DIR   backend directory            default /srv/quidey/backend
#   QUIDEY_DB    database name                default quidey
#   APP_USER     owner of QUIDEY_DIR          default quidey   (only used when run as root)
#   PG_SUPERUSER role that runs migrations    default postgres (only used when run as root)

set -euo pipefail

QUIDEY_DIR="${QUIDEY_DIR:-/srv/quidey/backend}"
QUIDEY_DB="${QUIDEY_DB:-quidey}"
APP_USER="${APP_USER:-quidey}"
PG_SUPERUSER="${PG_SUPERUSER:-postgres}"
MIGRATIONS="$QUIDEY_DIR/migrations"

die() { echo "quidey-migrate: $*" >&2; exit 1; }

if [ "$(id -u)" -eq 0 ]; then
    as_app=(runuser -u "$APP_USER" --)
    as_pg=(runuser -u "$PG_SUPERUSER" --)
else
    as_app=()
    as_pg=()
fi

# psql that fails loudly: no ~/.psqlrc, stop at the first error, quiet unless something breaks
psql_run() { "${as_pg[@]}" psql -X -q -v ON_ERROR_STOP=1 -d "$QUIDEY_DB" "$@"; }
# one value per line, no headers
psql_query() { psql_run -At -c "$1"; }

# Only one run at a time (deploy and a manual run at once would apply a file twice).
if command -v flock >/dev/null 2>&1; then
    # lock the script file itself: readable by everyone who may run it, no stale lock files
    exec 9<"$0"
    flock -n 9 || die "another migration run is in progress"
fi

# --- read the migration files ---------------------------------------------------------------

"${as_app[@]}" test -d "$MIGRATIONS" || die "cannot read $MIGRATIONS (wrong QUIDEY_DIR, or forgot sudo?)"

mapfile -t FILES < <("${as_app[@]}" find "$MIGRATIONS" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | LC_ALL=C sort)
[ "${#FILES[@]}" -gt 0 ] || die "no .sql files in $MIGRATIONS"

# Names are put into SQL below, so only allow the safe pattern; numbers must be unique,
# otherwise the order between two files with the same number is a coin toss.
declare -A seen_number=()
for f in "${FILES[@]}"; do
    [[ "$f" =~ ^([0-9]{3})_[a-z0-9_]+\.sql$ ]] || die "bad file name '$f' (expected NNN_lower_case_name.sql)"
    n="${BASH_REMATCH[1]}"
    [ -z "${seen_number[$n]:-}" ] || die "two migrations with number $n: ${seen_number[$n]} and $f"
    seen_number[$n]="$f"
done

file_sum() { "${as_app[@]}" cat "$MIGRATIONS/$1" | sha256sum | cut -d' ' -f1; }

# --- bookkeeping table ----------------------------------------------------------------------

psql_run -c "SET client_min_messages = warning; CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename   text PRIMARY KEY,
    checksum   text NOT NULL,
    applied_at timestamp with time zone NOT NULL DEFAULT now(),
    baseline   boolean NOT NULL DEFAULT false
);" >/dev/null

declare -A applied_sum=()
while IFS='|' read -r name sum; do
    [ -n "$name" ] && applied_sum["$name"]="$sum"
done < <(psql_query "SELECT filename, checksum FROM public.schema_migrations")

pending=()
for f in "${FILES[@]}"; do
    [ -n "${applied_sum[$f]:-}" ] || pending+=("$f")
done

warn_changed() {
    local f
    for f in "${FILES[@]}"; do
        if [ -n "${applied_sum[$f]:-}" ] && [ "${applied_sum[$f]}" != "$(file_sum "$f")" ]; then
            echo "warning: $f was changed after it was applied (it will NOT run again)" >&2
        fi
    done
    for f in "${!applied_sum[@]}"; do
        [ -n "${seen_number[${f:0:3}]:-}" ] && [ "${seen_number[${f:0:3}]}" = "$f" ] && continue
        echo "warning: $f is recorded as applied but the file no longer exists (renamed?)" >&2
    done
}

# --- commands -------------------------------------------------------------------------------

cmd="${1:-up}"

case "$cmd" in
status)
    warn_changed
    for f in "${FILES[@]}"; do
        if [ -n "${applied_sum[$f]:-}" ]; then echo "  applied  $f"; else echo "  PENDING  $f"; fi
    done
    echo "${#pending[@]} pending"
    ;;

baseline)
    upto="${2:-}"
    [[ "$upto" =~ ^[0-9]{3}$ ]] || die "usage: quidey-migrate baseline NNN   (e.g. baseline 017)"
    [ -n "${seen_number[$upto]:-}" ] || die "there is no migration $upto"
    sql=""
    for f in "${pending[@]}"; do
        [[ "${f:0:3}" > "$upto" ]] && continue
        sql+="INSERT INTO public.schema_migrations (filename, checksum, baseline) VALUES ('$f', '$(file_sum "$f")', true);"$'\n'
        echo "  marked   $f"
    done
    [ -n "$sql" ] || { echo "nothing to mark"; exit 0; }
    printf '%s' "$sql" | psql_run -1 >/dev/null
    echo "baseline done: these were recorded as applied, none of them was run"
    ;;

up)
    warn_changed
    if [ "${#pending[@]}" -eq 0 ]; then echo "database is up to date"; exit 0; fi
    # Safety net for the very first run: a database that already has tables but no history
    # would get every migration replayed. Make the operator decide with `baseline` instead.
    if [ "${#applied_sum[@]}" -eq 0 ] && [ "$(psql_query "SELECT to_regclass('public.users') IS NOT NULL")" = "t" ]; then
        die "this database already has tables but no migration history yet.
Check which migrations it already has, then record them once, e.g.:
    sudo quidey-migrate baseline 017
After that, plain 'quidey-migrate' only runs newer files."
    fi
    for f in "${pending[@]}"; do
        echo ">> $f"
        content="$("${as_app[@]}" cat "$MIGRATIONS/$f")"
        [ -n "${content//[[:space:]]/}" ] || die "$f is empty, stopping"
        sum="$(file_sum "$f")"
        # file + its bookkeeping row in one transaction (-1): all or nothing
        if ! printf '%s\n\nINSERT INTO public.schema_migrations (filename, checksum) VALUES (%s, %s);\n' \
                "$content" "'$f'" "'$sum'" | psql_run -1; then
            die "$f FAILED, nothing of it was applied; fix it and run again"
        fi
    done
    echo "applied ${#pending[@]} migration(s)"
    ;;

*)
    die "unknown command '$cmd' (use: status | up | baseline NNN)"
    ;;
esac
