"""Acceptance factory: replace only the external STAC network boundary.

All API routing, authentication, PostgreSQL authorization, geometry validation,
metadata interpretation and record review use the ordinary application code.
The local fixture proves the provider contract, not live Copernicus availability.
"""

import os
import hashlib
import json
from urllib.parse import urlsplit

import httpx


def configure_regulatory_provider():
    from funkyfarmers import regulatory
    from funkyfarmers.regulatory_sources import SourceObservation

    source = json.loads(os.environ["FUNKYFARMERS_TEST_REGULATORY_SOURCE"])
    endpoint = os.environ["FUNKYFARMERS_TEST_REGULATORY_URL"]
    if not source["id"].startswith("acceptance-") or urlsplit(endpoint).hostname != "127.0.0.1":
        raise RuntimeError("Authored regulatory fixture must use a generated ID and loopback transport.")

    def retrieve(selected, etag=None, last_modified=None):
        if selected["id"] != source["id"] or selected["url"] != source["url"]:
            raise RuntimeError("The fixture may only observe its generated source.")
        with httpx.Client(timeout=5, trust_env=False, follow_redirects=False) as client:
            response = client.get(endpoint, headers={"If-None-Match": etag} if etag else {})
            if response.status_code == 304:
                return SourceObservation("not_modified", 304, etag=response.headers.get("etag"))
            response.raise_for_status()
            return SourceObservation("observed", 200, hashlib.sha256(response.content).hexdigest(), response.headers.get("etag"))

    regulatory.fetch_source = retrieve
    return source


def create_app():
    from funkyfarmers import satellite
    from funkyfarmers import regulatory
    from funkyfarmers.app import create_app as production_app

    endpoint = os.environ["FUNKYFARMERS_TEST_STAC_URL"]
    if urlsplit(endpoint).hostname != "127.0.0.1":
        raise RuntimeError("Authored STAC fixture must use loopback.")

    def authored_provider(payload):
        with httpx.Client(timeout=5, trust_env=False, follow_redirects=False) as client:
            response = client.post(endpoint, json=payload)
            response.raise_for_status()
            return response.json()

    satellite.retrieve_scenes = authored_provider
    source = configure_regulatory_provider()
    # An explicitly generated external catalogue fixture is isolated from the
    # real publisher catalogue; no existing observation state is reset.
    regulatory.source_catalog = lambda: [source]
    return production_app()
