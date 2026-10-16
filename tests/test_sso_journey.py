"""Configured OIDC proves identity binding, not trust in an email address."""

import base64
import hashlib
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit
from uuid import uuid4

import httpx

from conftest import farm_data, human_browser


def test_sso_signed_identity_browser_native_linking_and_session_isolation(farmers, service_url, disabled_sso_url, authored_oidc):
    owner = farmers("Password account needing explicit SSO linking")
    outsider = farmers("Different tenant, including a colliding provider email")
    private_farm = owner.create("farms", farm_data("PRIVATE-SSO-HOLDING-" + uuid4().hex))
    state = authored_oidc["state"]
    provider = "authored-security"
    start_path = f"/auth/sso/{provider}/start"
    generated_email = "journey-sso-" + uuid4().hex + "@example.invalid"
    state.update(mode="valid", subject="authored-web-" + uuid4().hex, email=generated_email)

    def result(response, status, error=None):
        assert response.status_code == 303, response.text
        query = parse_qs(urlsplit(response.headers["location"]).query)
        assert query["sso"] == [status]
        if error:
            assert query["sso_error"] == [error]
        assert not {"token", "access_token", "id_token", "code", "state"} & query.keys()
        assert "no-store" in response.headers["cache-control"]

    def provider_callback(redirect_url):
        assert urlsplit(redirect_url).netloc == urlsplit(authored_oidc["issuer"]).netloc
        params = parse_qs(urlsplit(redirect_url).query)
        assert params["code_challenge_method"] == ["S256"]
        assert len(params["state"][0]) >= 32 and len(params["nonce"][0]) >= 32
        assert params["code_challenge"][0] != params["nonce"][0] and "client_secret" not in params
        with httpx.Client(timeout=10, trust_env=False, follow_redirects=False) as provider_browser:
            response = provider_browser.get(redirect_url)
        assert response.status_code == 302, response.text
        return response.headers["location"]

    def begin(browser, mode="login"):
        started = browser.post(start_path, json={"mode": mode, "return_to": "/app/home"})
        assert started.status_code == 200, started.text
        assert "httponly" in started.headers["set-cookie"].lower()
        assert started.json()["allow_local_development"] is True
        return provider_callback(started.json()["redirect_url"])

    with httpx.Client(base_url=disabled_sso_url + "/", timeout=30) as disabled:
        assert disabled.get("/auth/sso/providers").json()["providers"] == []
        assert disabled.post(start_path, json={"mode": "login", "return_to": "/app/home"}).status_code == 404
    providers = owner.get("/auth/sso/providers")
    assert provider in {item["id"] for item in providers.json()["providers"]}
    assert authored_oidc["client_secret"] not in providers.text
    with httpx.Client(base_url=service_url + "/", timeout=30) as anonymous:
        assert anonymous.post(start_path, json={"mode": "login", "return_to": "https://attacker.invalid"}).status_code == 422
        assert anonymous.post("/auth/sso/not-configured/start", json={"mode": "login"}).status_code == 404
        callback = begin(anonymous)
        with httpx.Client(base_url=service_url + "/", timeout=30) as different_browser:
            result(different_browser.get(callback), "failed", "invalid_state")
            assert different_browser.get("/auth/session").status_code == 401
        parsed = urlsplit(callback)
        query = parse_qs(parsed.query)
        query["state"] = [uuid4().hex + "x" * 11]
        malicious = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode({key: values[0] for key, values in query.items()}), ""))
        before = len([call for call in state["calls"] if call["method"] == "POST"])
        result(anonymous.get(malicious), "failed", "invalid_state")
        assert len([call for call in state["calls"] if call["method"] == "POST"]) == before
        assert anonymous.get("/auth/session").status_code == 401
    for invalid in ("nonce", "issuer", "audience", "signature"):
        state["mode"] = invalid
        with httpx.Client(base_url=service_url + "/", timeout=30) as anonymous:
            result(anonymous.get(begin(anonymous)), "failed", "invalid_identity")
            assert anonymous.get("/auth/session").status_code == 401

    state["mode"] = "valid"
    with httpx.Client(base_url=service_url + "/", timeout=30) as signed:
        callback = begin(signed)
        completed = signed.get(callback)
        result(completed, "signed_in")
        assert "httponly" in completed.headers["set-cookie"].lower()
        identity = signed.get("/auth/session").json()
        farmers.track_sso_session(identity, generated_email)
        assert identity["user"]["id"] not in {owner.user_id, outsider.user_id}
        signed.headers["X-CSRF-Token"] = identity["csrf_token"]
        accounts = signed.get("/auth/sso/accounts").json()
        assert accounts["password_enabled"] is False and accounts["items"][0]["can_unlink"] is False
        assert signed.post(f"/auth/sso/accounts/{accounts['items'][0]['id']}/unlink", json={}).status_code == 409
        created = signed.post("/farms", json={"data": farm_data("SSO-created account's own holding")})
        assert created.status_code == 201, created.text
        own_farm = created.json()
        outsider.get(f"/farms/{own_farm['id']}", expected=404)
        assert signed.get(f"/farms/{private_farm['id']}").status_code == 404
        exchanged_count = len([call for call in state["calls"] if call["method"] == "POST"])
        result(signed.get(callback), "failed", "invalid_state")
        assert len([call for call in state["calls"] if call["method"] == "POST"]) == exchanged_count

    # The native URL contains only an expiring one-use handoff, never a session
    # token. The app's verifier is distinct from the server-to-provider verifier.
    native_uri = "funkyfarmapp://auth/sso"
    verifier = uuid4().hex + uuid4().hex
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    native_state = uuid4().hex + uuid4().hex
    with httpx.Client(base_url=service_url + "/", timeout=30) as native_browser, httpx.Client(base_url=service_url + "/", timeout=30) as exchange:
        native_parameters = {"redirect_uri": native_uri, "state": native_state, "code_challenge": challenge, "code_challenge_method": "S256"}
        assert native_browser.get(f"/auth/sso/{provider}/native/start", params={**native_parameters, "redirect_uri": "attacker://auth/sso"}).status_code == 422
        started = native_browser.get(f"/auth/sso/{provider}/native/start", params=native_parameters)
        assert started.status_code == 303, started.text
        completed = native_browser.get(provider_callback(started.headers["location"]))
        target = urlsplit(completed.headers["location"])
        query = parse_qs(target.query)
        assert target.scheme == "funkyfarmapp" and target.netloc == "auth" and target.path == "/sso"
        assert set(query) == {"code", "state"} and query["state"] == [native_state]
        assert native_browser.get("/auth/session").status_code == 401
        handoff = {"code": query["code"][0], "code_verifier": verifier, "redirect_uri": native_uri}
        assert exchange.post("/auth/sso/native/token", json={**handoff, "code_verifier": "x" * 64}).status_code == 400
        assert exchange.post("/auth/sso/native/token", json={**handoff, "redirect_uri": "attacker://auth/sso"}).status_code == 400
        native = exchange.post("/auth/sso/native/token", json=handoff)
        assert native.status_code == 200, native.text
        assert native.json()["user"]["id"] == identity["user"]["id"] and native.json()["token"]
        assert exchange.post("/auth/sso/native/token", json=handoff).status_code == 400
        assert exchange.get(f"/farms/{private_farm['id']}", headers={"Authorization": "Bearer " + native.json()["token"]}).status_code == 404

    # An unverified email may create an opaque identity, never access to an
    # existing password account that happens to use that address.
    state.update(mode="unverified_email", subject="authored-unverified-" + uuid4().hex, email=owner.email)
    with httpx.Client(base_url=service_url + "/", timeout=30) as unverified:
        result(unverified.get(begin(unverified)), "signed_in")
        alias = unverified.get("/auth/session").json()
        farmers.track_sso_session(alias, owner.email)
        assert alias["user"]["id"] != owner.user_id and alias["user"]["email"].endswith("@sso.invalid")
        assert unverified.get(f"/farms/{private_farm['id']}").status_code == 404
    state.update(mode="valid", subject="authored-explicit-link-" + uuid4().hex, email=owner.email)
    with httpx.Client(base_url=service_url + "/", timeout=30) as collision:
        result(collision.get(begin(collision)), "failed", "account_link_required")
        assert collision.get("/auth/session").status_code == 401
    # Native/bearer sessions cannot silently attach a new external sign-in.
    owner.post("/auth/sso/authored/start", expected=403, json={"mode": "link", "return_to": "/app/home"})
    with human_browser(owner, service_url) as changed:
        callback = begin(changed, "link")
        assert changed.post("/auth/logout").status_code == 200
        logged_in = changed.post("/auth/login", json={"email": outsider.email, "password": outsider.password})
        assert logged_in.status_code == 200
        result(changed.get(callback), "failed", "session_changed")
    with human_browser(owner, service_url) as managed:
        result(managed.get(begin(managed, "link")), "linked")
        assert managed.get("/auth/session").json()["user"]["id"] == owner.user_id
        accounts = managed.get("/auth/sso/accounts").json()
        linked = next(item for item in accounts["items"] if item["provider_id"] == provider)
        assert accounts["password_enabled"] is True and linked["can_unlink"] is True
        managed.headers["X-CSRF-Token"] = managed.get("/auth/session").json()["csrf_token"]
        removed = managed.post(f"/auth/sso/accounts/{linked['id']}/unlink", json={})
        assert removed.status_code == 200 and removed.json() == {"unlinked": True, "signed_out": True}, removed.text
        assert managed.get("/auth/session").status_code == 401
    owner.get("/farms", expected=401)
    with human_browser(owner, service_url) as password_fallback:
        assert password_fallback.get(f"/farms/{private_farm['id']}").status_code == 200
    with httpx.Client(base_url=service_url + "/", timeout=30) as revoked:
        result(revoked.get(begin(revoked)), "failed", "account_link_required")
        assert revoked.get("/auth/session").status_code == 401
    state.update(mode="valid", subject="authored-reset-" + uuid4().hex, email="journey-sso-" + uuid4().hex + "@example.invalid")
