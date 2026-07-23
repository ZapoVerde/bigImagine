#!/bin/bash
# Runs once, on first container start against an empty data volume (docker-entrypoint-initdb.d
# convention). Creates the non-superuser role the orchestrator connects as at runtime — RLS
# policies are meaningless against POSTGRES_USER itself, since that role is a superuser and
# superusers always bypass row security regardless of FORCE ROW LEVEL SECURITY.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	DO \$\$
	BEGIN
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bigbrain_app') THEN
	    CREATE ROLE bigbrain_app LOGIN PASSWORD '${BIGBRAIN_APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
	  END IF;
	END
	\$\$;
	GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO bigbrain_app;
EOSQL
