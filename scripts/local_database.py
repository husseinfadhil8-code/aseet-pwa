"""Password-free local PostgreSQL and Supabase migration runner. No hosted DSNs accepted."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid

from install_supabase_cli import CLI

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / ".local-database/state.json"
LABEL = "dev.waseet.local-database"

# Minimal platform fixtures for plain PostgreSQL, NOT copies of production data
# or a replacement for testing hosted GoTrue, Storage API, JWT or PostgREST.
PLATFORM_FIXTURE = """
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE supabase_auth_admin NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY, raw_user_meta_data jsonb DEFAULT '{}');
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$;
CREATE SCHEMA storage;
CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,
 file_size_limit bigint,allowed_mime_types text[]);
CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 bucket_id text REFERENCES storage.buckets(id),name text,owner uuid,metadata jsonb);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
 SELECT (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1];
$$;
GRANT USAGE ON SCHEMA public,auth,storage TO anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated,service_role;
"""


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, timeout=120, **kwargs)


class LocalDatabase:
    def __init__(self, name=None):
        self.name = name or "waseet-local-" + uuid.uuid4().hex[:12]

    def start(self):
        try:
            run(["docker", "run", "--pull=never", "-d", "--rm", "--name", self.name,
                 "--label", LABEL, "--network", "none",
                 "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17"])
            for _ in range(150):
                process = run(["docker", "exec", self.name, "cat", "/proc/1/comm"])
                ready = subprocess.run(["docker", "exec", self.name, "pg_isready", "-U", "postgres"],
                                       capture_output=True, timeout=10)
                if process.stdout.strip() == "postgres" and ready.returncode == 0:
                    break
                time.sleep(0.2)
            else:
                raise RuntimeError("Local PostgreSQL did not become ready")
            self.validate()
            self.sql(PLATFORM_FIXTURE)
            return self
        except BaseException:
            self.stop()
            raise

    def validate(self):
        info = json.loads(run(["docker", "inspect", self.name]).stdout)[0]
        if LABEL not in info["Config"].get("Labels", {}) or info["HostConfig"]["NetworkMode"] != "none":
            raise RuntimeError("Refusing to use an unowned or non-isolated database")
        if info["HostConfig"].get("PortBindings") or any(m["Type"] == "bind" for m in info["Mounts"]):
            raise RuntimeError("Refusing published ports or host bind mounts")
        return self

    def sql(self, query, check=True, database='postgres'):
        if database not in ('postgres', 'waseet_restore_rehearsal'):
            raise RuntimeError('Unexpected local database name')
        return subprocess.run(["docker", "exec", "-i", self.name, "psql", "-X", "-qAt", "-U", "postgres",
                               "-d", database,
                               "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"],
                              input=query, text=True, capture_output=True, check=check, timeout=30)

    def cli(self, *args):
        self.validate()
        if not CLI.exists():
            raise RuntimeError("Install the pinned CLI: python3 scripts/install_supabase_cli.py")
        # Run the verified CLI INSIDE this networkless container. It receives no
        # host credentials and cannot reach any hosted database, even accidentally.
        if args not in (("migration", "up"), ("migration", "list")):
            raise RuntimeError("Only local migration up/list are supported")
        run(["docker", "cp", str(CLI), self.name + ":/tmp/waseet-supabase"])
        run(["docker", "exec", self.name, "mkdir", "-p", "/tmp/waseet/supabase"])
        run(["docker", "exec", self.name, "rm", "-rf", "/tmp/waseet/supabase/migrations"])
        run(["docker", "cp", str(ROOT / "supabase/config.toml"), self.name + ":/tmp/waseet/supabase/config.toml"])
        run(["docker", "cp", str(ROOT / "supabase/migrations"), self.name + ":/tmp/waseet/supabase/migrations"])
        return run(["docker", "exec", "-e", "PGSSLMODE=disable", self.name, "/tmp/waseet-supabase", *args,
                    # Only container-internal loopback; plain PostgreSQL has no TLS server.
                    "--db-url", "postgresql://postgres@127.0.0.1:5432/postgres?sslmode=disable",
                    "--workdir", "/tmp/waseet", "--yes"])

    def migrate(self):
        return self.cli("migration", "up")

    def stop(self):
        # Delete only resources bearing our label. No resets of arbitrary containers.
        found = subprocess.run(["docker", "inspect", self.name], capture_output=True, text=True, timeout=10)
        if found.returncode == 0:
            info = json.loads(found.stdout)[0]
            if LABEL not in info["Config"].get("Labels", {}):
                raise RuntimeError("Refusing to stop an unowned container")
            run(["docker", "rm", "-f", "-v", self.name])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["start", "migrate", "status", "stop"])
    command = parser.parse_args().command
    if command == "start":
        if STATE.exists():
            raise RuntimeError("Local state exists; use status or stop first")
        if not CLI.exists():
            raise RuntimeError("Run python3 scripts/install_supabase_cli.py first")
        database = LocalDatabase().start()
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps({"name": database.name}))
        print(database.migrate().stdout)
        print(f"Local test database ready: {database.name}; no network, ports, passwords or API keys")
    else:
        database = LocalDatabase(json.loads(STATE.read_text())["name"])
        if command == "stop":
            database.stop()
            STATE.unlink()
            print("Removed only this project's local test database")
        else:
            result = database.migrate() if command == "migrate" else database.cli("migration", "list")
            print(result.stdout)
            print(result.stderr)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(error.stderr or error.stdout or str(error), file=sys.stderr)
        raise SystemExit(error.returncode)
