"""Provision the named local test database; never clear existing records."""
import os
import psycopg
from psycopg.conninfo import conninfo_to_dict

url = os.environ['FUNKYFARMERS_ADMIN_DATABASE_URL']
settings = conninfo_to_dict(url)
if settings.get('dbname') != 'funkyfarmers' or settings.get('host') not in {'127.0.0.1', 'localhost'} or settings.get('port') != '55439':
    raise SystemExit('Expected the dedicated local FunkyFarmers database on port 55439')
with psycopg.connect(url, autocommit=True) as connection:
    if not connection.execute("SELECT 1 FROM pg_database WHERE datname='funkyfarmers_test'").fetchone():
        connection.execute('CREATE DATABASE funkyfarmers_test OWNER funkyfarmers_admin')
print('Dedicated local development and test databases available.')
