-- Creates the database role the server runs as: it may read and write Quidey's data,
-- but it is no superuser, can't create or drop tables, roles or databases.
-- Run it as the admin user (postgres) once on the server, after schema.sql / the migrations:
--
--   psql -U postgres -d quidey -v app_password='<long random password>' -f scripts/db-app-role.sql
--
-- Then put DB_USER=quidey_app and that password into the server's .env.
-- Migrations keep running as postgres; new tables are granted to quidey_app automatically
-- (ALTER DEFAULT PRIVILEGES below).

\set ON_ERROR_STOP on

SELECT 'CREATE ROLE quidey_app LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'quidey_app') \gexec

ALTER ROLE quidey_app WITH LOGIN PASSWORD :'app_password'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    CONNECTION LIMIT 50;

-- connect to this database only, and use its tables, nothing else
REVOKE ALL ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"DBNAME" TO quidey_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO quidey_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO quidey_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO quidey_app;

-- tables and sequences that later migrations create (as postgres) get the same rights
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO quidey_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO quidey_app;

-- runaway queries are stopped instead of tying up the database
ALTER ROLE quidey_app SET statement_timeout = '15s';
