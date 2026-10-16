#!/bin/sh
set -eu
umask 077
ulimit -f 2097152

for target in database.dump originals.tar counts.json; do
    if [ -e "/backup/$target" ]; then
        printf '%s\n' 'Backup destination must be empty.' >&2
        exit 1
    fi
done

psql --no-password --no-psqlrc --tuples-only --no-align \
    --set=ON_ERROR_STOP=1 --file=/tools/recovery-counts.sql > /backup/counts.json
pg_dump --no-password --format=custom --no-owner --no-tablespaces \
    --file=/backup/database.dump
tar --create --file=/backup/originals.tar --directory=/originals .
printf '%s\n' 'Database snapshot and private originals captured.'
