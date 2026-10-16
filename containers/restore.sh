#!/bin/sh
set -eu
umask 077

if [ "$(psql --no-password --no-psqlrc --tuples-only --no-align \
    --set=ON_ERROR_STOP=1 --command="SELECT count(*) FROM pg_namespace WHERE nspname='funkyfarm'")" != 0 ]; then
    printf '%s\n' 'Recovery refuses an already populated schema.' >&2
    exit 1
fi
if [ -n "$(find /restore-originals -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    printf '%s\n' 'Recovery originals volume must be empty.' >&2
    exit 1
fi

psql --no-password --no-psqlrc --set=ON_ERROR_STOP=1 \
    --set=runtime_password="$FUNKYFARM_RUNTIME_PASSWORD" <<'SQL'
CREATE ROLE funkyfarm_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'runtime_password';
SQL
pg_restore --no-password --exit-on-error --no-owner --no-tablespaces \
    --dbname="$PGDATABASE" /backup/database.dump
tar --extract --file=/backup/originals.tar --directory=/restore-originals \
    --no-same-owner --no-same-permissions
chown -R 10001:10001 /restore-originals
chmod 0700 /restore-originals
printf '%s\n' 'Restored into the isolated recovery database and originals volume.'
