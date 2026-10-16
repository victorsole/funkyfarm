"""Acceptance factory: replace only external network transport boundaries.

All API routing, authentication, PostgreSQL authorization, geometry validation,
metadata interpretation and record review use the ordinary application code.
The local fixture proves the provider contract, not live Copernicus availability.
"""

import os
import json
from urllib.parse import urlsplit

import httpx


def configure_regulatory_provider():
    source = json.loads(os.environ["FUNKYFARM_TEST_REGULATORY_SOURCE"])
    endpoint = os.environ["FUNKYFARM_TEST_REGULATORY_URL"]
    if not source["id"].startswith("acceptance-") or urlsplit(endpoint).hostname != "127.0.0.1":
        raise RuntimeError("Authored regulatory fixture must use a generated ID and loopback transport.")

    actual_transport = httpx.AsyncHTTPTransport.handle_async_request

    async def loopback_transport(transport, request):
        if str(request.url) != source["url"]:
            raise RuntimeError("The fixture may only observe its generated official source URL.")
        # Keep the official URL at AsyncClient, with its real allowlist checks,
        # response policy, stream limits, validators, hashing and hard deadline.
        # Only the socket destination changes; even Host remains official.
        forwarded = httpx.Request(request.method, endpoint, headers=request.headers,
                                  stream=request.stream, extensions=request.extensions)
        return await actual_transport(transport, forwarded)

    httpx.AsyncHTTPTransport.handle_async_request = loopback_transport
    return source


def create_app():
    from funkyfarm import satellite
    from funkyfarm import regulatory
    from funkyfarm.app import create_app as production_app

    endpoint = os.environ["FUNKYFARM_TEST_STAC_URL"]
    if urlsplit(endpoint).hostname != "127.0.0.1":
        raise RuntimeError("Authored STAC fixture must use loopback.")

    actual_transport = httpx.HTTPTransport.handle_request

    def public_parcel_transport(transport, request):
        if request.url.host == "api.pdok.nl":
            if request.url.scheme != "https" or request.url.path != "/rvo/gewaspercelen/ogc/v1/collections/brpgewas/items":
                raise RuntimeError("Only the reviewed PDOK public parcel request may use the fixture.")
            local = httpx.URL(endpoint).copy_with(path="/pdok", query=request.url.query)
            forwarded = httpx.Request(request.method, local, headers=request.headers,
                                      stream=request.stream, extensions=request.extensions)
            return actual_transport(transport, forwarded)
        if request.url.host not in {"127.0.0.1", "localhost"}:
            raise RuntimeError("Acceptance HTTP must stay at an authored local provider.")
        return actual_transport(transport, request)

    # Keep configured_base, the real streaming/parser limits and every request
    # header. Change only the socket destination of this reviewed public URL.
    httpx.HTTPTransport.handle_request = public_parcel_transport

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
