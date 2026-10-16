"""Loopback OpenID provider fixture; application verification stays unmodified."""

import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import time
from urllib.parse import parse_qs, urlencode, urlsplit
from uuid import uuid4

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
import pytest


def _base64(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


@pytest.fixture(scope="session")
def authored_oidc():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    wrong_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = key.public_key().public_numbers()
    jwk = {"kty": "RSA", "kid": "authored-signing-key", "use": "sig", "alg": "RS256",
           "n": _base64(public.n.to_bytes((public.n.bit_length() + 7) // 8, "big")),
           "e": _base64(public.e.to_bytes((public.e.bit_length() + 7) // 8, "big"))}
    state = {"mode": "valid", "subject": "authored-subject-" + uuid4().hex,
             "email": "journey-sso-" + uuid4().hex + "@example.invalid", "calls": [], "codes": {}}

    class Handler(BaseHTTPRequestHandler):
        def respond(self, payload, status=200):
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            parsed = urlsplit(self.path)
            state["calls"].append({"method": "GET", "path": parsed.path})
            if parsed.path == "/.well-known/openid-configuration":
                self.respond({"issuer": issuer, "authorization_endpoint": issuer + "/authorize", "token_endpoint": issuer + "/token",
                    "jwks_uri": issuer + "/jwks", "response_types_supported": ["code"], "subject_types_supported": ["public"],
                    "id_token_signing_alg_values_supported": ["RS256"], "code_challenge_methods_supported": ["S256"],
                    "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post", "none"]})
            elif parsed.path == "/jwks":
                self.respond({"keys": [jwk]})
            elif parsed.path == "/authorize":
                params = {name: values[0] for name, values in parse_qs(parsed.query).items()}
                redirect = urlsplit(params.get("redirect_uri", ""))
                if (redirect.scheme != "http" or redirect.hostname != "127.0.0.1" or not redirect.path.startswith("/api/v1/auth/")
                        or params.get("response_type") != "code" or params.get("code_challenge_method") != "S256"
                        or not params.get("state") or not params.get("nonce")):
                    self.respond({"error": "invalid_request"}, 400)
                    return
                code = "authored-code-" + uuid4().hex
                state["codes"][code] = {**params, "mode": state["mode"], "subject": state["subject"], "email": state["email"], "used": False}
                self.send_response(302)
                self.send_header("Location", params["redirect_uri"] + "?" + urlencode({"code": code, "state": params["state"]}))
                self.end_headers()
            else:
                self.respond({"error": "not_found"}, 404)

        def do_POST(self):
            params = {name: values[0] for name, values in parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode()).items()}
            state["calls"].append({"method": "POST", "path": self.path, "code": params.get("code")})
            granted = state["codes"].get(params.get("code"))
            challenge = _base64(hashlib.sha256(params.get("code_verifier", "").encode()).digest())
            if (self.path != "/token" or not granted or granted["used"] or params.get("grant_type") != "authorization_code"
                    or params.get("client_id") != granted["client_id"] or params.get("client_secret") != "authored-local-test-secret"
                    or params.get("redirect_uri") != granted["redirect_uri"] or challenge != granted["code_challenge"]):
                self.respond({"error": "invalid_grant"}, 400)
                return
            granted["used"] = True
            claims = {"iss": issuer, "sub": granted["subject"], "aud": granted["client_id"], "iat": int(time.time()),
                      "exp": int(time.time()) + 300, "nonce": granted["nonce"], "email": granted["email"],
                      "email_verified": True, "name": "Authored SSO farmer"}
            mode = granted["mode"]
            if mode == "nonce":
                claims["nonce"] = "unrelated-nonce"
            elif mode == "issuer":
                claims["iss"] = "https://untrusted-issuer.invalid"
            elif mode == "audience":
                claims["aud"] = "different-client"
            elif mode == "expired":
                claims["exp"] = int(time.time()) - 120
            elif mode == "unverified_email":
                claims["email_verified"] = False
            encoded = ".".join((_base64(json.dumps({"alg": "RS256", "kid": jwk["kid"], "typ": "JWT"}, separators=(",", ":")).encode()),
                                _base64(json.dumps(claims, separators=(",", ":")).encode())))
            signature = (wrong_key if mode == "signature" else key).sign(encoded.encode(), padding.PKCS1v15(), hashes.SHA256())
            self.respond({"access_token": "authored-inert-provider-token", "token_type": "Bearer", "expires_in": 300,
                          "id_token": encoded + "." + _base64(signature)})

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    issuer = f"http://127.0.0.1:{server.server_port}"
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield {"issuer": issuer, "state": state, "client_id": "authored-sso-client", "client_secret": "authored-local-test-secret"}
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
