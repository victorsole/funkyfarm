"""Real HTTP journeys against an explicitly provisioned, dedicated PostgreSQL DB.

The runner supplies both test DSNs. No existing database is migrated or reset here.
Only UUIDs returned by registrations made in this fixture are eligible for cleanup.
"""

from dataclasses import dataclass
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import hashlib
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
from uuid import UUID, uuid4

import httpx
import psycopg
from psycopg.conninfo import conninfo_to_dict
import pytest

PROJECT = Path(__file__).resolve().parents[1]
TEST_DATABASE = "funkyfarm_test"


def checked_database(variable):
    value = os.environ.get(variable)
    if not value:
        pytest.fail(f"Set {variable} to the dedicated {TEST_DATABASE} PostgreSQL database.")
    options = conninfo_to_dict(value)
    if options.get("dbname") != TEST_DATABASE:
        pytest.fail(f"Refusing {variable}: database must be exactly {TEST_DATABASE}.")
    with psycopg.connect(value, connect_timeout=5) as connection:
        if connection.execute("SELECT current_database()").fetchone()[0] != TEST_DATABASE:
            pytest.fail("Connected database did not match the dedicated test database.")
    return value


@pytest.fixture(scope="session")
def browser_origin():
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        return f"http://127.0.0.1:{reservation.getsockname()[1]}"


@pytest.fixture(scope="session")
def authored_stac():
    calls = []
    public_calls = []
    outline = {"type": "Polygon", "coordinates": [[[11.0, 48.0], [11.001, 48.0], [11.001, 48.001], [11.0, 48.001], [11.0, 48.0]]]}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            public_calls.append({"path": self.path, "headers": dict(self.headers)})
            if self.path.startswith("/sigpac/"):
                return self.sigpac()
            crop_outline = {"type": "Polygon", "coordinates": [[[5, 52], [5.002, 52], [5.002, 52.001], [5, 52.001], [5, 52]]]}
            ditch_outline = {"type": "Polygon", "coordinates": [[[5.0021, 52], [5.0022, 52], [5.0022, 52.001], [5.0021, 52.001], [5.0021, 52]]]}
            features = [
                {"type": "Feature", "id": "authored-crop-007", "geometry": crop_outline,
                 "properties": {"category": "Gewasperceel", "gewas": "Wintertarwe", "gewascode": "011", "jaar": 2025, "status": "Actueel", "bron": "Authored PDOK transport fixture"}},
                {"type": "Feature", "id": "authored-ditch-008", "geometry": ditch_outline,
                 "properties": {"category": "Sloot", "gewas": None, "gewascode": None, "jaar": 2025, "status": "Actueel", "bron": "Authored PDOK transport fixture"}},
            ]
            payload = json.dumps({"type": "FeatureCollection", "features": features, "numberMatched": 2, "links": []}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/geo+json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def sigpac(self):
            # Authored FEGA transport: the five retained Cáceres recintos, their published facts
            # and one pond. Proves the connector contract, not live SIGPAC availability.
            demo = json.loads((PROJECT / "shared" / "spain-sigpac-demo.json").read_text(encoding="utf-8"))

            def mercator(point):
                return [math.radians(point[0]) * 6378137.0, math.log(math.tan(math.pi / 4 + math.radians(point[1]) / 2)) * 6378137.0]

            def parts(reference):
                return dict(zip(("provincia", "municipio", "agregado", "zona", "poligono", "parcela", "recinto"), (int(v) for v in reference.split(":"))))
            path = self.path.split("?")[0]
            if path.startswith("/sigpac/mvt/"):
                payload = {"type": "FeatureCollection", "features": [
                    {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[mercator(p) for p in ring] for ring in field["geometry"]["coordinates"]]},
                     "properties": {**parts(field["reference"]), "uso_sigpac": field["use_code"], "pendiente_media": 3.0, "altitud": 390,
                                    "coef_regadio": None, "incidencias": field["incidences"], "region": 15}} for field in demo["fields"]]}
            elif path.startswith("/sigpac/servicioconsultassigpac/query/recinfoparc/"):
                wanted = path.rsplit("/", 1)[-1].removesuffix(".json")
                payload = [{**{k: str(v) for k, v in parts(field["reference"]).items()}, "superficie": str(field["area_ha"]), "admisibilidad": str(field["csp_percent"]),
                            "uso_sigpac": field["use_code"], "incidencias": str(field["incidences"]), "region": "15", "secret_field": "never kept"}
                           for field in demo["fields"] if field["reference"].split(":")[5] == wanted]
            elif path.startswith("/sigpac/ogcapi/collections/elementos_paisaje_area/items"):
                payload = {"type": "FeatureCollection", "links": [], "features": [
                    {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[-6.4705, 39.4985], [-6.4703, 39.4985], [-6.4703, 39.4987], [-6.4705, 39.4987], [-6.4705, 39.4985]]]},
                     "properties": {"dn_pk": 1, "provincia": 10, "municipio": 50, "tipo_elemento": "CH"}}]}
            elif path.startswith("/sigpac/ogcapi/collections/"):
                payload = {"type": "FeatureCollection", "links": [], "features": []}
            else:
                self.send_response(404); self.end_headers(); return
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            calls.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            scenes = []
            for identifier, cloud in (("AUTHORED-CLOUDY", 92), ("AUTHORED-UNKNOWN", None), ("AUTHORED-CLEAR", 0)):
                properties = {"datetime": "2025-05-10T10:00:00Z", "platform": "authored-provider-fixture"}
                if cloud is not None:
                    properties["eo:cloud_cover"] = cloud
                scenes.append({"type": "Feature", "id": identifier, "collection": "sentinel-2-l2a", "geometry": outline, "properties": properties})
            payload = json.dumps({"type": "FeatureCollection", "features": scenes, "links": []}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/geo+json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield {"url": f"http://127.0.0.1:{server.server_port}/search", "calls": calls, "public_calls": public_calls}
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


@pytest.fixture(scope="session")
def authored_regulatory():
    admin_url = checked_database("FUNKYFARM_TEST_ADMIN_DATABASE_URL")
    source = {"id": "acceptance-" + uuid4().hex, "url": "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32025R2203",
              "title": "Authored publisher HTTP fixture, not a legal conclusion", "country": "SK", "region": None,
              "workflow_ids": ["inputs"], "source_type": "official_legislation", "source_edition": "authored-response",
              "catalog_checked_at": "2026-10-16", "rule_ids": [], "rules": []}
    state = {"body": b"Authored initial publisher response", "calls": [], "status": 200}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            state["calls"].append({"path": self.path, "headers": dict(self.headers)})
            etag = '"' + hashlib.sha256(state["body"]).hexdigest() + '"'
            unchanged = self.headers.get("If-None-Match") == etag
            status = state["status"] if state["status"] != 200 else 304 if unchanged else 200
            self.send_response(status)
            self.send_header("ETag", '"pending-not-a-source-validator"' if status == 202 else etag)
            self.send_header("Last-Modified", "Sat, 17 Oct 2026 01:00:00 GMT" if status == 202 else "Fri, 16 Oct 2026 00:00:00 GMT")
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            if status != 304:
                self.wfile.write(b"Publisher request pending; not a source body." if status == 202 else state["body"])

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    endpoint = f"http://127.0.0.1:{server.server_port}/official-page"

    def poll():
        # Advance only this generated public source's schedule, never other rows.
        with psycopg.connect(admin_url, connect_timeout=5) as connection:
            connection.execute("UPDATE funkyfarm.regulatory_source_state SET next_check_at=now(),lease_until=NULL WHERE source_id=%s AND url=%s", (source["id"], source["url"]))
        environment = {**os.environ, "FUNKYFARM_DATABASE_URL": checked_database("FUNKYFARM_TEST_DATABASE_URL"),
                       "FUNKYFARM_TEST_REGULATORY_SOURCE": json.dumps(source), "FUNKYFARM_TEST_REGULATORY_URL": endpoint,
                       "PYTHONPATH": os.pathsep.join([str(PROJECT / "services/api"), str(PROJECT / "tests")])}
        result = subprocess.run([sys.executable, str(PROJECT / "tests/poll_authored_source.py")], env=environment, cwd=PROJECT,
                                capture_output=True, text=True, timeout=30,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        assert result.returncode == 0, result.stderr[-4000:]
        return json.loads(result.stdout)

    def retained_state():
        with psycopg.connect(admin_url, connect_timeout=5, row_factory=psycopg.rows.dict_row) as connection:
            row = connection.execute("SELECT content_hash,etag,last_modified,last_status,last_http_status,failure_count FROM funkyfarm.regulatory_source_state WHERE source_id=%s AND url=%s", (source["id"], source["url"])).fetchone()
            assert row is not None
            return row

    try:
        yield {"source": source, "url": endpoint, "state": state, "poll": poll, "retained_state": retained_state}
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
        with psycopg.connect(admin_url, connect_timeout=5) as connection:
            connection.execute("DELETE FROM funkyfarm.regulatory_source_events WHERE source_id=%s AND source_url=%s", (source["id"], source["url"]))
            connection.execute("DELETE FROM funkyfarm.regulatory_source_state WHERE source_id=%s AND url=%s", (source["id"], source["url"]))


@pytest.fixture(scope="session")
def authored_model():
    state = {"calls": [], "mode": "workflow", "hold": False, "entered": threading.Event(), "release": threading.Event()}
    model, digest = "authored-local:fixture", "1" * 64

    class Handler(BaseHTTPRequestHandler):
        def respond(self, payload):
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            state["calls"].append({"path": self.path})
            self.respond({"models": [{"name": model, "model": model, "digest": "sha256:" + digest, "size": 536870912}]})

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            state["calls"].append({"path": self.path, "body": payload})
            if self.path == "/api/show":
                self.respond({"details": {"format": "gguf"}})
                return
            if self.path != "/api/generate":
                self.send_error(404)
                return
            if state["hold"]:
                state["entered"].set()
                state["release"].wait(timeout=10)
            prompt = json.loads(payload["prompt"].split("<|im_start|>user\n", 1)[1].split("<|im_end|>\n<|im_start|>assistant", 1)[0])
            kind = "workflow"
            if state["mode"] == "legal":
                source = next(item for item in prompt["sources"] if item["id"].startswith("L"))
                kind = "legal"
            else:
                source = next(item for item in prompt["sources"] if item["id"] == "W0")
            quote = source["excerpt"].split(". ")[0] + "."
            answer = {"answer": "Read and explicitly review the source before confirming an entry.", "source_ids": [source["id"]],
                      "quotes": [{"source_id": source["id"], "text": quote}], "status": "answered", "kind": kind}
            if state["mode"] == "legal":
                answer["answer"] = "UNSUPPORTED-LEGAL-CERTAINTY: every farm is legally compliant."
            elif state["mode"] == "invented":
                answer.update(answer="UNSUPPORTED-EXTERNAL-CLAIM https://attacker.invalid", source_ids=["MADE-UP-SOURCE"])
            self.respond({"model": model, "done": True, "response": json.dumps(answer)})

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield {"url": f"http://127.0.0.1:{server.server_port}", "model": model, "digest": digest, "state": state}
    finally:
        state["release"].set()
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


@pytest.fixture(scope="session")
def authored_nebih():
    """Authored SOAP1.1 authority responses; no authority socket is ever used."""
    from cryptography.fernet import Fernet
    from xml.etree import ElementTree as ET
    from xml.sax.saxutils import escape

    soap = "http://schemas.xmlsoap.org/soap/envelope/"
    gn = "http://gazdanaplo.aap.nebih.gov.hu/"
    state = {"mode": "happy", "calls": []}
    config = {"FUNKYFARM_NEBIH_ENABLED": "1", "FUNKYFARM_NEBIH_ENVIRONMENT": "test", "FUNKYFARM_NEBIH_ACCESS_MODE": "ip",
        "FUNKYFARM_NEBIH_USERNAME": "authored-nebih-user", "FUNKYFARM_NEBIH_PASSWORD": "authored-nebih-password",
        "FUNKYFARM_NEBIH_SYSTEM_ID": "authored-system", "FUNKYFARM_CONNECTIONS_KEY": Fernet.generate_key().decode("ascii")}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            state["calls"].append({"path": self.path, "headers": dict(self.headers), "body": body})
            root = ET.fromstring(body)
            wrapper = root.find(f"{{{soap}}}Body")[0]
            operation = wrapper.tag.split("}")[-1]
            message_id = wrapper.findtext("callContext/messageId")
            params = {item.findtext("key"): item.findtext("value") for item in wrapper.findall("callContext/parameterList/parameter")}
            page = int(params.get("pagenumber", "1"))
            site_id, use_id = "0007" + str(page), "0009" + str(page)
            if operation == "getGnNovtermAdatokE1":
                business = f'<gazdalkodasi-naplo-novterm><gn-termohely-list><gn-termohely><id>{site_id}</id><allapot-kod>0007</allapot-kod><gn-hasznositas-list><gn-hasznositas-extend><id>{use_id}</id><kultura-list xsi:nil="true"/><allapot/><allapot-kod>0</allapot-kod><gazdalkodasi-ev-kod>2026</gazdalkodasi-ev-kod></gn-hasznositas-extend></gn-hasznositas-list></gn-termohely></gn-termohely-list></gazdalkodasi-naplo-novterm>'
            elif operation == "getGnNovtermMuveletekE1":
                site_id, use_id = wrapper.findtext("callParameter/termohely-id"), wrapper.findtext("callParameter/hasznositas-id")
                business = f'<gn-termohely><id>{site_id}</id><gn-hasznositas-list><gn-hasznositas-muvelet><id>{use_id}</id><novenyterm-muvelet-list><novenyterm-muvelet-extend><id>00101</id><hasznositas-id>{use_id}</hasznositas-id><muvelet-csoport-kod>0003</muvelet-csoport-kod><idopont-kezdet>2026-06-11</idopont-kezdet><agrotechnika><muvelet-tipus-kod>0007</muvelet-tipus-kod><muvelet>Authored művelet, not confirmed work</muvelet><teruletmeret xsi:type="xs:decimal">1.2500</teruletmeret><fajlagos-menny>0.500</fajlagos-menny><fajlagos-menny-me-kod>0042</fajlagos-menny-me-kod></agrotechnika></novenyterm-muvelet-extend></novenyterm-muvelet-list></gn-hasznositas-muvelet></gn-hasznositas-list></gn-termohely>'
            else:
                self.send_error(400)
                return
            mode = state["mode"]
            if operation == "getGnNovtermMuveletekE1" and mode == "wrong_site":
                business = business.replace(f"<id>{site_id}</id>", "<id>99999</id>", 1)
            elif operation == "getGnNovtermMuveletekE1" and mode == "wrong_use":
                business = business.replace(f"<gn-hasznositas-muvelet><id>{use_id}</id>", "<gn-hasznositas-muvelet><id>99999</id>", 1)
            severity = {"unknown": "UNRECOGNISED", "warning": "WARNING", "error": "ERROR"}.get(mode, "INFO")
            token = wrapper.findtext("tokenAdat/token", "")
            echo = escape("Authored echo: " + " ".join([token, config["FUNKYFARM_NEBIH_PASSWORD"]]))
            context = f'<resultContext><messageId>{message_id}</messageId><highestMessageSeverity>{severity}</highestMessageSeverity><messageList><message><code>0000</code><severity>INFO</severity><sourceSystemCode>AUTHORED</sourceSystemCode><text>101</text></message><message><code>AUTHORED-ECHO</code><severity>{severity}</severity><text>{echo}</text></message></messageList></resultContext>'
            content = f'<s:Envelope xmlns:s="{soap}" xmlns:g="{gn}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="http://www.w3.org/2001/XMLSchema"><s:Body><g:{operation}Response><result>{context}{business}</result></g:{operation}Response></s:Body></s:Envelope>'.encode()
            status = 200
            if mode == "fault":
                content = f'<s:Envelope xmlns:s="{soap}"><s:Body><s:Fault><faultcode>Server</faultcode><faultstring>{echo}</faultstring></s:Fault></s:Body></s:Envelope>'.encode()
            elif mode == "dtd":
                content = b'<!DOCTYPE x [<!ENTITY harmless "DTD must still be rejected">]>' + content
            elif mode == "malformed":
                content = b'<not-complete>'
            elif mode in {"oversize", "stream_oversize"}:
                content = b' ' * (4 * 1024 * 1024 + 1)
            elif mode == "wrong_namespace":
                content = content.replace(gn.encode(), b"https://authored.invalid/not-the-contract")
            elif mode in {"redirect", "http_error"}:
                status, content = (302 if mode == "redirect" else 503), echo.encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/xml; charset=utf-8")
            if mode != "stream_oversize":
                self.send_header("Content-Length", str(len(content)))
            if mode in {"encoding", "deflate"}:
                self.send_header("Content-Encoding", "deflate" if mode == "deflate" else "gzip")
            if mode == "redirect":
                self.send_header("Location", "https://authored.invalid/must-not-follow")
            self.end_headers()
            try:
                self.wfile.write(content)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield {"url": f"http://127.0.0.1:{server.server_port}/nebih", "state": state, "config": config}
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


@pytest.fixture(scope="session")
def service_url(tmp_path_factory, browser_origin, authored_stac, authored_regulatory, authored_model, authored_nebih):
    runtime_url = checked_database("FUNKYFARM_TEST_DATABASE_URL")
    checked_database("FUNKYFARM_TEST_ADMIN_DATABASE_URL")
    directory = tmp_path_factory.mktemp("funkyfarm-http")
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    environment = {
        **os.environ,
        "FUNKYFARM_DATABASE_URL": runtime_url,
        "FUNKYFARM_STORAGE_ROOT": str(directory / "private-files"),
        "FUNKYFARM_COOKIE_SECURE": "false",
        "FUNKYFARM_ALLOWED_ORIGINS": browser_origin + ",http://127.0.0.1:5189,http://localhost:5189",
        "PYTHONPATH": os.pathsep.join([str(PROJECT / "services" / "api"), str(PROJECT / "tests")]),
        "FUNKYFARM_TEST_STAC_URL": authored_stac["url"],
        "FUNKYFARM_PDOK_BASE_URL": "https://api.pdok.nl/rvo/gewaspercelen/ogc/v1",
        "FUNKYFARM_TEST_REGULATORY_SOURCE": json.dumps(authored_regulatory["source"]),
        "FUNKYFARM_TEST_REGULATORY_URL": authored_regulatory["url"],
        "FUNKYFARM_REGULATORY_MONITOR_ENABLED": "false",
        "FUNKYFARM_WHISPER_ENABLED": "false",
        "FUNKYFARM_OAUTH_ALLOW_LOCAL_HTTP": "true",
        "FUNKYFARM_PUBLIC_URL": f"http://127.0.0.1:{port}",
        "FUNKYFARM_WEB_URL": browser_origin,
        "FUNKYFARM_OLLAMA_ENABLED": "true",
        "FUNKYFARM_OLLAMA_BASE_URL": authored_model["url"],
        "FUNKYFARM_OLLAMA_MODEL": authored_model["model"],
        "FUNKYFARM_OLLAMA_MODEL_DIGEST": "sha256:" + authored_model["digest"],
        **authored_nebih["config"],
        "FUNKYFARM_TEST_NEBIH_URL": authored_nebih["url"],
    }
    url = f"http://127.0.0.1:{port}/api/v1"
    with (directory / "server.log").open("w+", encoding="utf-8") as log:
        process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "provider_app:create_app", "--factory",
             "--host", "127.0.0.1", "--port", str(port)],
            cwd=PROJECT, env=environment, stdout=log, stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and process.poll() is None:
                try:
                    if httpx.get(url + "/auth/session", timeout=1).status_code == 401:
                        break
                except httpx.TransportError:
                    pass
                time.sleep(0.1)
            else:
                log.seek(0)
                pytest.fail("Dedicated HTTP service did not become ready:\n" + log.read()[-8000:])
            yield url
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


@pytest.fixture(scope="session")
def browser_app(service_url, browser_origin, tmp_path_factory):
    directory = tmp_path_factory.mktemp("funkyfarm-browser")
    environment = {**os.environ, "FUNKYFARM_BROWSER_API_URL": service_url.removesuffix("/api/v1")}
    node = os.environ.get("FUNKYFARM_NODE", "node")
    port = browser_origin.rsplit(":", 1)[1]
    command = [node, str(PROJECT / "apps/web/node_modules/vite/bin/vite.js"),
               "--config", str(PROJECT / "tests/browser/vite.config.mjs"),
               "--configLoader", "native", "--port", port]
    with (directory / "vite.log").open("w+", encoding="utf-8") as log:
        process = subprocess.Popen(command, cwd=PROJECT, env=environment, stdout=log, stderr=subprocess.STDOUT,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and process.poll() is None:
                try:
                    if httpx.get(browser_origin, timeout=1).status_code == 200:
                        break
                except httpx.TransportError:
                    pass
                time.sleep(0.1)
            else:
                log.seek(0)
                pytest.fail("Isolated browser app did not become ready:\n" + log.read()[-8000:])
            yield {"url": browser_origin, "directory": directory, "node": node}
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


@dataclass
class Farmer:
    client: httpx.Client
    identity: dict
    email: str
    password: str

    @property
    def workspace_id(self):
        return self.identity["workspace"]["id"]

    @property
    def user_id(self):
        return self.identity["user"]["id"]

    def request(self, method, path, *, expected=200, **kwargs):
        response = self.client.request(method, path, **kwargs)
        assert response.status_code == expected, f"{method} {path}: {response.status_code} {response.text[:1500]}"
        return response

    def get(self, path, **kwargs):
        return self.request("GET", path, **kwargs)

    def post(self, path, **kwargs):
        return self.request("POST", path, **kwargs)

    def patch(self, path, **kwargs):
        return self.request("PATCH", path, **kwargs)

    def create(self, kind, data, **kwargs):
        return self.post(f"/{kind}", json={"data": data}, expected=kwargs.pop("expected", 201), **kwargs).json()


@pytest.fixture
def oauth_registration(service_url):
    admin_url = checked_database("FUNKYFARM_TEST_ADMIN_DATABASE_URL")
    name = "Authored connector " + uuid4().hex
    callback = "https://chatgpt.com/connector_platform_oauth_redirect"
    with httpx.Client(base_url=service_url + "/", timeout=30, follow_redirects=False) as client:
        response = client.post("assistant/oauth/register", json={"client_name": name, "redirect_uris": [callback],
            "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"]})
        assert response.status_code == 201, response.text
        registered = response.json()
        try:
            yield {**registered, "callback": callback}
        finally:
            with psycopg.connect(admin_url, connect_timeout=5) as connection:
                connection.execute("DELETE FROM funkyfarm.assistant_oauth_requests WHERE data->>'client_id'=%s", (registered["client_id"],))
                connection.execute("DELETE FROM funkyfarm.assistant_oauth_clients WHERE client_id=%s AND metadata->>'client_name'=%s", (registered["client_id"], name))


@pytest.fixture
def farmers(service_url):
    admin_url = checked_database("FUNKYFARM_TEST_ADMIN_DATABASE_URL")
    # The session-scoped HTTP service sees every journey at this same address.
    # Isolate its shared address budget between tests, not within a journey;
    # each generated identity still has the unchanged per-email sign-in limit.
    with psycopg.connect(admin_url, connect_timeout=5) as connection:
        assert connection.execute("SELECT current_database()").fetchone()[0] == TEST_DATABASE
        connection.execute(
            "DELETE FROM funkyfarm.auth_attempts WHERE bucket=%s",
            ("address:" + hashlib.sha256(b"127.0.0.1").hexdigest(),),
        )
    created = []

    def register(name):
        email = f"journey-{uuid4().hex}@example.invalid"
        password = "Test-only-password-" + uuid4().hex
        client = httpx.Client(base_url=service_url + "/", timeout=30)
        try:
            response = client.post("auth/register", json={"email": email, "password": password, "display_name": name})
            assert response.status_code == 201, response.text
            identity = response.json()
            UUID(identity["workspace"]["id"])
            UUID(identity["user"]["id"])
            farmer = Farmer(client, identity, email, password)
            created.append(farmer)
            client.headers.update({"Authorization": "Bearer " + identity["token"]})
            return farmer
        except BaseException:
            client.close()
            raise

    def change_generated_membership(farmer, permissions):
        if farmer not in created:
            raise AssertionError("Only this fixture's generated identities may be changed.")
        with psycopg.connect(admin_url, connect_timeout=5) as connection:
            changed = connection.execute(
                "UPDATE funkyfarm.memberships SET permissions=%s "
                "WHERE workspace_id=%s AND user_id=%s",
                (permissions, UUID(farmer.workspace_id), UUID(farmer.user_id)),
            )
            assert changed.rowcount == 1

    register.change_generated_membership = change_generated_membership

    def expire_generated_qualification(farmer, profile_id, expires_on):
        if farmer not in created:
            raise AssertionError("Only this fixture's generated identities may be changed.")
        with psycopg.connect(admin_url, connect_timeout=5) as connection:
            changed = connection.execute(
                "UPDATE funkyfarm.public_content SET data=jsonb_set(data,'{qualification_expires_on}',to_jsonb(%s::text)) "
                "WHERE id=%s AND author_id=%s AND kind='adviser_profile'",
                (expires_on, UUID(profile_id), UUID(farmer.user_id)),
            )
            assert changed.rowcount == 1

    register.expire_generated_qualification = expire_generated_qualification

    @contextmanager
    def lock_generated_record(farmer, kind, record_id):
        if farmer not in created:
            raise AssertionError("Only this fixture's generated workspaces may be locked.")
        with psycopg.connect(admin_url, connect_timeout=5) as connection:
            record = connection.execute(
                "SELECT id FROM funkyfarm.records WHERE id=%s AND workspace_id=%s AND kind=%s FOR UPDATE",
                (UUID(record_id), UUID(farmer.workspace_id), kind),
            ).fetchone()
            assert record is not None
            blocker_pid = connection.execute("SELECT pg_backend_pid()").fetchone()[0]

            def wait_for_api_waiter():
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    connection.execute("SELECT pg_stat_clear_snapshot()")
                    waiting = connection.execute(
                        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() "
                        "AND %s=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'",
                        (blocker_pid,),
                    ).fetchone()
                    if waiting:
                        return
                    threading.Event().wait(0.05)
                raise AssertionError("The concurrent HTTP approval did not reach the database row-lock gate.")

            yield wait_for_api_waiter

    register.lock_generated_record = lock_generated_record

    try:
        yield register
    finally:
        for farmer in created:
            farmer.client.close()
        if created:
            # Cleanup is deliberately restricted to returned UUIDs from this test.
            # Neither TRUNCATE nor a database/schema reset is permitted.
            with psycopg.connect(admin_url, connect_timeout=5) as connection:
                assert connection.execute("SELECT current_database()").fetchone()[0] == TEST_DATABASE
                for farmer in created:
                    # A generated owner can now create additional fictional
                    # workspaces. Remove those before any generated actor, since
                    # advisers may appear in another owner's retained history.
                    connection.execute(
                        "DELETE FROM funkyfarm.workspaces w USING funkyfarm.users u "
                        "WHERE w.owner_id=u.id AND u.id=%s AND u.email=%s",
                        (UUID(farmer.user_id), farmer.email),
                    )
                for farmer in created:
                    connection.execute("DELETE FROM funkyfarm.users WHERE id=%s AND email=%s", (UUID(farmer.user_id), farmer.email))


@pytest.fixture
def community_reviewer(farmers):
    reviewer = farmers("Generated independent community reviewer")
    admin_url = checked_database("FUNKYFARM_TEST_ADMIN_DATABASE_URL")
    with psycopg.connect(admin_url, connect_timeout=5) as connection:
        configured = connection.execute(
            "INSERT INTO funkyfarm.community_reviewers(user_id) "
            "SELECT id FROM funkyfarm.users WHERE id=%s AND email=%s",
            (UUID(reviewer.user_id), reviewer.email),
        )
        assert configured.rowcount == 1
    # The generated user owns this reviewer entry; normal user cleanup cascades it.
    return reviewer


def farm_data(name="Meadow test farm"):
    return {"name": name, "country": "DE", "region": "Bavaria", "reporting_year": 2026, "area_ha": 3.75}


def fact_data(farm_id, *, key="area_ha", value=3.75, unit="ha", period="2026", basis="campaign_year", sources=None):
    return {
        "farm_id": farm_id, "key": key, "label": key.replace("_", " "), "value": value,
        "unit": unit, "period": period, "temporal_basis": basis, "sources": sources or [],
        "review_status": "proposed",
    }


def confirm(farmer, fact, note="Checked against the authored journey evidence."):
    return farmer.post(f"/facts/{fact['id']}/review", json={
        "expected_revision": fact["revision"], "decision": "confirmed", "note": note,
    }).json()


@contextmanager
def human_browser(farmer, service_url):
    with httpx.Client(base_url=service_url + "/", timeout=30) as client:
        login = client.post("auth/login", json={"email": farmer.email, "password": farmer.password})
        assert login.status_code == 200, login.text
        client.headers.update({"X-CSRF-Token": login.json()["csrf_token"], "Origin": "http://127.0.0.1:5189"})
        yield client
