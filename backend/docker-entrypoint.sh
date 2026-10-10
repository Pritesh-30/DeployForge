#!/bin/sh
# Bring the schema up to date, then serve. Migrations are safe to re-run, so a
# restarted container never starts against an older schema than its code.
set -e

alembic upgrade head

# The router terminates TLS and forwards to us, so trust its X-Forwarded-*
# headers: otherwise every request looks like plain HTTP from Traefik's IP.
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 \
    --proxy-headers --forwarded-allow-ips="*"
