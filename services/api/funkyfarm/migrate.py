"""Explicit admin-only fresh schema setup; runtime credentials remain separate."""

from importlib.resources import files
import os

import psycopg
from psycopg import sql


def main():
    url = os.environ.get("FUNKYFARM_ADMIN_DATABASE_URL", "")
    password = os.environ.get("FUNKYFARM_RUNTIME_PASSWORD", "")
    if not url.startswith(("postgresql://", "postgres://")):
        raise SystemExit("Set FUNKYFARM_ADMIN_DATABASE_URL to a PostgreSQL migration connection.")
    if len(password) < 20:
        raise SystemExit("Set a fresh FUNKYFARM_RUNTIME_PASSWORD with at least 20 characters.")
    with psycopg.connect(url, autocommit=True) as conn:
        privileges = conn.execute("SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user").fetchone()
        if not privileges or not privileges[0]:
            raise SystemExit("The separate migration identity must have RLS bypass privileges for bounded SECURITY DEFINER functions. Never use it as the runtime identity.")
        if not conn.execute("SELECT 1 FROM pg_roles WHERE rolname='funkyfarm_app'").fetchone():
            conn.execute("CREATE ROLE funkyfarm_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS")
        conn.execute(sql.SQL("ALTER ROLE funkyfarm_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD {}").format(sql.Literal(password)))
        with conn.transaction():
            conn.execute(files("funkyfarm").joinpath("schema.sql").read_text(encoding="utf-8"))
    print("FunkyFarm schema installed; runtime role is nonowner and cannot bypass row-level security.")


if __name__ == "__main__":
    main()
