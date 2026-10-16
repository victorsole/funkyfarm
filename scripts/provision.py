"""Provision the named local test database; never clear existing records."""
import os
import psycopg
from psycopg.conninfo import conninfo_to_dict

url = os.environ['FUNKYFARM_ADMIN_DATABASE_URL']
settings = conninfo_to_dict(url)
if settings.get('dbname') != 'funkyfarm' or settings.get('host') not in {'127.0.0.1', 'localhost'} or settings.get('port') != '55440':
    raise SystemExit('Expected the dedicated local FunkyFarm database on port 55440')
with psycopg.connect(url, autocommit=True) as connection:
    if not connection.execute("SELECT 1 FROM pg_database WHERE datname='funkyfarm_test'").fetchone():
        connection.execute('CREATE DATABASE funkyfarm_test OWNER funkyfarm_admin')
print('Dedicated local development and test databases available.')
