"""Create or resume jury samples through ordinary authenticated APIs.

Local mode is the default target. Production requires two explicit flags and
can target only https://funkyfarm.elfeel.me. Neither mode publishes sample
community/adviser content. Credentials and retry state stay in separate,
ignored, owner-access-only local files; passwords are never printed.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
from urllib.parse import urlsplit

import httpx


PROJECT = Path(__file__).resolve().parents[1]
PRIVATE = PROJECT / "runtime" / "jury"
DEFAULT_FILE = PRIVATE / "local-credentials.json"
PRODUCTION_FILE = PRIVATE / "production-credentials.json"
LOCAL_API = "http://127.0.0.1:8139/api/v1"
LOCAL_WEB = "http://127.0.0.1:5189"
PRODUCTION_WEB = "https://funkyfarm.elfeel.me"
PRODUCTION_API = PRODUCTION_WEB + "/api/v1"
FIXTURE = "lpis-correction-2026-v1"
FIXTURE_VERSION = 5


class SeedError(Exception):
    pass


def protect_directory(path: Path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink():
        raise SeedError("The private handoff directory must not be a symbolic link.")
    if os.name == "nt":
        result = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"], capture_output=True, text=True, check=True)
        sid = next(csv.reader(result.stdout.strip().splitlines()))[-1]
        if not re.fullmatch(r"S-\d+(?:-\d+)+", sid):
            raise SeedError("Could not establish the current Windows account for private storage.")
        subprocess.run(["icacls", str(path), "/inheritance:r", "/grant:r", f"*{sid}:(OI)(CI)F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    else:
        path.chmod(0o700)


def save(path: Path, state):
    temporary = path.with_suffix(".pending")
    if path.is_symlink() or temporary.is_symlink():
        raise SeedError("The private handoff and its pending file must not be symbolic links.")
    descriptor = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    if os.name != "nt":
        path.chmod(0o600)


def load(path: Path, api=LOCAL_API):
    if path.exists():
        if path.is_symlink():
            raise SeedError("The credential handoff must not be a symbolic link.")
        state = json.loads(path.read_text(encoding="utf-8"))
        if state.get("version") != 1 or state.get("api") != api:
            raise SeedError("This handoff belongs to a different seed or API. Nothing was overwritten.")
        # The previous script saved accounts before requesting its unversioned
        # workspace key, but did not retain a response from an older fixture.
        # Replay that exact key once to recover its identity, never delete it.
        if "demo" not in state and "workspace_requests" not in state and any(
                account.get("registered") for account in state.get("accounts", {}).values()):
            state["legacy_workspace_pending"] = True
            state["workspace_requests"] = {}
            save(path, state)
        return state
    seed_id = secrets.token_hex(12)
    notice = ("Local sample accounts only. Never publish these credentials or reuse the passwords elsewhere."
              if api == LOCAL_API else
              "Production jury sample accounts for https://funkyfarm.elfeel.me only. Share credentials only through an authorized private handoff; never reuse these passwords elsewhere.")
    state = {"version": 1, "api": api, "seed_id": seed_id,
             "notice": notice,
             "accounts": {}, "steps": {}}
    for key, name in (("farmer", "Jury sample farmer"), ("adviser", "Sample adviser Marta"), ("viewer", "Sample adviser Tom")):
        state["accounts"][key] = {"email": f"jury.{key}.{seed_id}@funkyfarm.invalid",
                                  "password": secrets.token_urlsafe(24), "display_name": name}
    save(path, state)
    return state


class Client:
    def __init__(self, api):
        if api not in {LOCAL_API, PRODUCTION_API}:
            raise SeedError("The jury seed accepts only its fixed local or production API target.")
        origin = LOCAL_WEB if api == LOCAL_API else PRODUCTION_WEB
        self.client = httpx.Client(base_url=api + "/", trust_env=False, follow_redirects=False,
                                   verify=True, timeout=httpx.Timeout(45, connect=5), headers={"Origin": origin})
        self.user_id = None

    def call(self, method, path, body=None, key=None):
        parsed = urlsplit(path)
        if not path.startswith("/") or path.startswith("//") or parsed.scheme or parsed.netloc or parsed.fragment or "\\" in path or any(part in {".", ".."} for part in parsed.path.split("/")):
            raise SeedError("A retained seed request has an invalid API-relative path. No request was sent.")
        headers = {"Idempotency-Key": key} if key else {}
        response = self.client.request(method, path.lstrip("/"), json=body, headers=headers)
        if response.status_code >= 300:
            try:
                code = response.json().get("error", {}).get("code", "request_failed")
            except ValueError:
                code = "request_failed"
            if not isinstance(code, str) or not re.fullmatch(r"[A-Za-z0-9_:-]{1,80}", code):
                code = "request_failed"
            raise SeedError(f"API returned {response.status_code} ({code}); private retry state was retained.")
        return response.json()

    def sign_in(self, account):
        self.client.headers.pop("X-Workspace-ID", None)
        result = None
        if not account.get("registered"):
            try:
                result = self.call("POST", "/auth/register", {key: account[key] for key in ("email", "password", "display_name")})
            except SeedError as exc:
                if "409 (registration_unavailable)" not in str(exc):
                    raise
        if result is None:
            result = self.call("POST", "/auth/login", {key: account[key] for key in ("email", "password")})
        # The ordinary native/CLI bearer session remains memory-only. This also
        # works if a local operator has configured the web cookie as Secure.
        self.client.headers["Authorization"] = "Bearer " + result["token"]
        self.client.headers["X-CSRF-Token"] = result["csrf_token"]
        self.user_id = result["user"]["id"]
        account.update(registered=True, user_id=self.user_id, personal_workspace_id=result["workspace"]["id"])
        return result

    def workspace(self, identifier):
        self.client.headers["X-Workspace-ID"] = identifier
        return self.call("GET", "/auth/session")

    def close(self):
        try:
            if self.user_id:
                self.call("POST", "/auth/logout")
        finally:
            self.client.close()


def step(state, private_file, client, name, method, path, body):
    retained = state["steps"].get(name)
    if retained and retained.get("result") is not None:
        return retained["result"]
    if retained is None:
        retained = {"method": method, "path": path, "body": body,
                    "key": "jury-" + hashlib.sha256((state["seed_id"] + ":" + name).encode()).hexdigest()}
        state["steps"][name] = retained
        save(private_file, state)
    result = client.call(retained["method"], retained["path"], retained["body"], retained["key"])
    retained["result"] = result
    save(private_file, state)
    return result


def ensure_membership(state, private_file, owner, member, account_key, workspace_id, farms, permissions):
    if any(item["id"] == workspace_id for item in member.call("GET", "/workspaces")["items"]):
        return
    account = state["accounts"][account_key]
    if account.get("accepted_workspace_id") == workspace_id:
        raise SeedError("A sample adviser grant was revoked. It was not silently recreated; review the intended access first.")
    pending = account.get("invitation")
    if pending and pending.get("invitation", {}).get("workspace_id") != workspace_id:
        raise SeedError("A pending sample invitation belongs to an older workspace. Its token was retained; review it before granting access to a new demo.")
    if pending is None:
        pending = owner.call("POST", "/invitations", {"email": account["email"], "role": "adviser",
            "farm_ids": farms, "permissions": permissions, "expires_in_days": 30})
        account["invitation"] = pending
        save(private_file, state)
    member.call("POST", "/invitations/accept", {"token": pending["token"]})
    account.pop("invitation", None)
    account["accepted_workspace_id"] = workspace_id
    save(private_file, state)


def request_workspace(state, private_file, owner, key):
    requests = state.setdefault("workspace_requests", {})
    retained = requests.get(key)
    if retained is None:
        result = owner.call("POST", "/examples/workspace", {"fixture_id": FIXTURE, "acknowledged": True}, key)
        retained = {"run_id": result["run_id"], "workspace_id": result["workspace"]["id"],
                    "fixture_version": result.get("fixture_version")}
        requests[key] = retained
        save(private_file, state)
    return retained


def seed(state, private_file):
    clients = {key: Client(state["api"]) for key in state["accounts"]}
    try:
        for key, client in clients.items():
            client.sign_in(state["accounts"][key])
            save(private_file, state)
        owner, adviser, viewer = (clients[key] for key in ("farmer", "adviser", "viewer"))
        if "demo" in state:
            owner.workspace(state["demo"]["workspace_id"])
            retained = owner.call("GET", "/examples/workspace/" + state["demo"]["run_id"])
            retained_version = retained.get("fixture_version")
            if retained_version != FIXTURE_VERSION:
                if type(retained_version) is not int or retained_version > FIXTURE_VERSION:
                    raise SeedError("The retained demo has an unsupported version. No workspace was replaced.")
                state.setdefault("previous_demos", []).append({
                    "fixture_version": retained_version, "demo": state.pop("demo"),
                    "steps": state.pop("steps", {}), "handoff": state.pop("handoff", None),
                })
                state["steps"] = {}
                state["ready"] = False
                save(private_file, state)
        if "demo" not in state:
            result = None
            if state.get("legacy_workspace_pending"):
                legacy = request_workspace(state, private_file, owner, "jury-workspace-" + state["seed_id"])
                state["legacy_workspace_pending"] = False
                save(private_file, state)
                if legacy.get("fixture_version") == FIXTURE_VERSION:
                    result = legacy
            if result is None:
                result = request_workspace(state, private_file, owner,
                                           f"jury-workspace-v{FIXTURE_VERSION}-" + state["seed_id"])
            if result.get("fixture_version") != FIXTURE_VERSION:
                raise SeedError(f"The API did not create the current v{FIXTURE_VERSION} fixture. Its run identity is retained privately; no run was replaced. Deploy this fixture version before seeding. A version-scoped key already bound to an older fixture needs operator review, not an automatic new attempt.")
            state["demo"] = {"run_id": result["run_id"], "workspace_id": result["workspace_id"]}
            save(private_file, state)
        workspace_id = state["demo"]["workspace_id"]
        owner.workspace(workspace_id)
        demo = owner.call("GET", "/examples/workspace/" + state["demo"]["run_id"])
        by_alias = {item["alias"]: item for item in demo["records"] if item.get("alias")}
        es_farm = by_alias["es-farm"]["id"]
        nl_farm = by_alias["nl-missing-farm"]["id"]
        ensure_membership(state, private_file, owner, adviser, "adviser", workspace_id, demo["farm_ids"], ["read", "review"])
        ensure_membership(state, private_file, owner, viewer, "viewer", workspace_id, [es_farm], ["read"])
        adviser.workspace(workspace_id)
        viewer.workspace(workspace_id)
        for key, client in (("adviser", adviser), ("viewer", viewer)):
            if not client.call("GET", "/advisers/profile")["items"]:
                client.call("POST", "/advisers/profile", {"display_name": state["accounts"][key]["display_name"],
                    "bio": ("Sample contact for the local jury workspace. Not a real service provider or a verified professional."
                            if state["api"] == LOCAL_API else
                            "Sample contact for the jury demo workspace. Not a real service provider or a verified professional."),
                    "countries": ["ES", "NL"], "languages": ["en"], "qualification_claim": "No professional qualification claimed.", "publish": False})
        conversations = [
            ("outline", es_farm, "How should I compare the D04 outlines?",
             "Sample question: the private original fills three holes in the public reference. Which boundary and claim figures should I check separately?",
             "Sample reply: compare the complete public geometry, save a private outline proposal, and review it separately before applying it. The published area, CSP and calculated claim proposal are separate answers; nothing here updates SIGPAC or files a claim."),
            ("land-use", nl_farm, "Which land-use evidence is still missing?",
             "Sample question: the mock notice asks for a land-use record. The drawing alone does not establish a right to claim. What should I ask for next?",
             "Sample reply: identify the actual record requested by the recipient and select its current original after checking it. The sample folder intentionally leaves that evidence missing; do not treat a drawing or an example document as proof of land rights."),
        ]
        for name, farm_id, title, body, reply in conversations:
            question = step(state, private_file, owner, "question-" + name, "POST", "/adviser/questions",
                            {"farm_id": farm_id, "recipient_id": adviser.user_id, "title": title, "body": body})
            step(state, private_file, adviser, "reply-" + name, "POST", f"/adviser/questions/{question['id']}/reply",
                 {"expected_revision": question["revision"], "body": reply})
        step(state, private_file, owner, "question-open", "POST", "/adviser/questions",
             {"farm_id": es_farm, "recipient_id": adviser.user_id, "title": "What evidence would support disputing the source?",
              "body": "Sample open question: no lease or dated geotagged photo is provided. Keep that evidence gap visible before preparing any source allegation."})
        extra = [
            ("purchases", "purchase", {"farm_id": nl_farm, "title": "Sample seed purchase", "date": "2026-09-14", "category": "seeds", "quantity": 50,
              "unit": "kg", "amount": 142.5, "currency": "EUR", "supplier": "Sample seed supplier", "invoice_number": "DEMO-PURCHASE-001", "notes": "Sample purchase only, not proof of application.", "review_status": "proposed"}),
            ("sales", "sale", {"farm_id": nl_farm, "title": "Sample produce sale", "date": "2026-10-10", "category": "produce", "quantity": 120,
              "unit": "kg", "amount": 98.5, "currency": "EUR", "buyer": "Sample farm shop", "invoice_number": "DEMO-SALE-001", "notes": "Sample sale, not an actual invoice or payment.", "review_status": "proposed"}),
            ("tasks", "task", {"farm_id": es_farm, "title": "Check the sample evidence folder", "status": "open",
              "description": "Review the public-source transcription and identify which actual records are still missing. Do not mark a source allegation or filing as complete."}),
        ]
        for kind, name, data in extra:
            step(state, private_file, owner, "extra-" + name, "POST", "/" + kind, {"data": data})
        state["ready"] = True
        web_url = LOCAL_WEB if state["api"] == LOCAL_API else PRODUCTION_WEB
        state["handoff"] = {"web_url": web_url, "workspace_id": workspace_id,
            "entry_url": f"{web_url}/app/demo?run_id={state['demo']['run_id']}&workspace_id={workspace_id}",
            "sign_in_note": "Sign in with the sample account, then choose Open demo or select the sample workspace. The account's original personal workspace stays separate.",
            "farmer": "Owner of the isolated sample workspace", "adviser": "Real adviser membership, read/review on the seven sample farms",
            "viewer": "Real adviser membership, read only on the Spain sample farm", "community": "Private farm-scoped sample questions, never public posts",
            "qualification": "Sample adviser profiles remain private drafts and unverified."}
        state["readback"] = {
            "farms": owner.call("GET", "/farms?limit=100")["total"],
            "private_questions": owner.call("GET", "/adviser/questions?limit=50")["total"],
            "spain_contacts": len(owner.call("GET", f"/adviser/recipients?farm_id={es_farm}")["items"]),
            "viewer_visible_farms": viewer.call("GET", "/farms?limit=100")["total"],
            "purchases": owner.call("GET", f"/purchases?farm_id={nl_farm}&limit=50")["total"],
            "sales": owner.call("GET", f"/sales?farm_id={nl_farm}&limit=50")["total"],
        }
        save(private_file, state)
        return {"workspace_id": workspace_id, "run_id": state["demo"]["run_id"]}
    finally:
        for client in clients.values():
            try:
                client.close()
            except (SeedError, httpx.HTTPError):
                pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--create-local-jury", action="store_true", help="Explicitly authorize creating/resuming local sample accounts and records")
    mode.add_argument("--production", action="store_true", help="Select only https://funkyfarm.elfeel.me; also requires --acknowledge-production-seed")
    parser.add_argument("--acknowledge-production-seed", action="store_true", help="Authorize creating/resuming the jury sample accounts and private records on the fixed production host")
    parser.add_argument("--api", help="Optional exact API target, which must match the selected mode")
    args = parser.parse_args()
    if args.production != args.acknowledge_production_seed:
        parser.error("Production requires both --production and --acknowledge-production-seed; the acknowledgement cannot be used in local mode.")
    api = PRODUCTION_API if args.production else LOCAL_API
    supplied_api = args.api if args.api is not None else api
    parsed = urlsplit(supplied_api)
    if supplied_api.rstrip("/") != api or parsed.query or parsed.fragment:
        parser.error("The selected mode accepts only " + api + ". No other host, port, credentials or URL parameters are allowed.")
    private_file = PRODUCTION_FILE if args.production else DEFAULT_FILE
    try:
        protect_directory(PRIVATE)
        state = load(private_file, api)
        result = seed(state, private_file)
    except (SeedError, httpx.HTTPError, OSError, ValueError, subprocess.SubprocessError) as exc:
        message = str(exc) if isinstance(exc, SeedError) else "Jury seed could not finish; private state was retained for an explicit retry."
        print(message, file=sys.stderr)
        return 1
    print(("Production" if args.production else "Local") + " jury sample ready. No public content was published.")
    print("Workspace: " + result["workspace_id"])
    print("Private credential handoff: " + str(private_file))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
