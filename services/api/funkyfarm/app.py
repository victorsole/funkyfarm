"""Versioned local API entry point. No SQLite or privileged-runtime fallback."""

from contextlib import asynccontextmanager
from importlib import import_module
import logging
import os
import tempfile

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from psycopg import Error as DatabaseError
from psycopg.errors import CheckViolation, InsufficientPrivilege, UniqueViolation
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import Request

from . import __version__
from .db import auth_transaction
from .models import ApiError
from .records import router as records_router
from .security import require_session, router as auth_router

logger = logging.getLogger("funkyfarm")


class RequestBodyLimit:
    """Authenticate imports and bound their bytes before multipart can spool them.

    The request is staged to a private temporary file, with a fixed-size replay
    buffer. Neither a missing nor a forged Content-Length bypasses the cap.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in {"POST", "PUT", "PATCH", "DELETE"}:
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        upload = path == "/api/v1/imports" or path.startswith("/api/v1/documents")
        maximum = 21 * 1024 * 1024 if upload else (64 * 1024 if path.startswith("/api/v1/auth/") else 1024 * 1024)
        lengths = [value for name, value in scope.get("headers", []) if name.lower() == b"content-length"]
        declared = None
        if lengths:
            if len(lengths) != 1 or not lengths[0].isdigit():
                await error_response(400, "invalid_content_length", "Supply one valid content length.")(scope, receive, send)
                return
            if len(lengths[0]) > 10:
                await error_response(413, "request_too_large", "This request exceeds the upload limit.", {"maximum_bytes": maximum})(scope, receive, send)
                return
            declared = int(lengths[0])
            if declared > maximum:
                await error_response(413, "request_too_large", "This request exceeds the upload limit.", {"maximum_bytes": maximum})(scope, receive, send)
                return
        # Import authentication runs before reading any CSV or multipart bytes.
        if path == "/api/v1/imports":
            try:
                await run_in_threadpool(require_session, Request(scope, receive))
            except ApiError as exc:
                await error_response(exc.status, exc.code, exc.message, exc.details)(scope, receive, send)
                return
            except DatabaseError:
                await error_response(503, "database_unavailable", "The private workspace service is temporarily unavailable.")(scope, receive, send)
                return
        with tempfile.TemporaryFile(mode="w+b") as staged:
            size = 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                if message["type"] != "http.request":
                    continue
                body = message.get("body", b"")
                size += len(body)
                if size > maximum:
                    await error_response(413, "request_too_large", "This request exceeds the upload limit.", {"maximum_bytes": maximum})(scope, receive, send)
                    return
                await run_in_threadpool(staged.write, body)
                if not message.get("more_body", False):
                    break
            if declared is not None and declared != size:
                await error_response(400, "content_length_mismatch", "The request length did not match its declared size.")(scope, receive, send)
                return
            await run_in_threadpool(staged.seek, 0)
            remaining = size
            replay_complete = False

            async def replay():
                nonlocal remaining, replay_complete
                if replay_complete:
                    return await receive()
                chunk = await run_in_threadpool(staged.read, min(65536, remaining))
                remaining -= len(chunk)
                replay_complete = remaining == 0
                return {"type": "http.request", "body": chunk, "more_body": remaining > 0}

            await self.app(scope, replay, send)


@asynccontextmanager
async def lifespan(app):
    with auth_transaction() as conn:
        conn.execute("SELECT 1")
    from .regulatory import start_regulatory_worker, stop_regulatory_worker
    worker = start_regulatory_worker()
    try:
        yield
    finally:
        await stop_regulatory_worker(worker)


def error_response(status, code, message, details=None):
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message, "details": details or {}}},
                        headers={"Cache-Control": "no-store"})


def create_app():
    app = FastAPI(title="FunkyFarm", version=__version__, lifespan=lifespan)
    origins = [origin.strip() for origin in os.environ.get(
        "FUNKYFARM_ALLOWED_ORIGINS", "http://localhost:5189,http://127.0.0.1:5189,http://localhost:8139,http://127.0.0.1:8139"
    ).split(",") if origin.strip()]
    if "*" in origins:
        raise RuntimeError("Credentialed browser origins must be explicit")
    app.add_middleware(RequestBodyLimit)
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=True,
                       allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
                       allow_headers=["Authorization", "Content-Type", "X-CSRF-Token", "X-Workspace-ID", "Idempotency-Key"],
                       expose_headers=["Content-Disposition"])

    @app.middleware("http")
    async def private_responses(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.exception_handler(ApiError)
    async def api_error(request, exc):
        response = error_response(exc.status, exc.code, exc.message, exc.details)
        if exc.status == 401 and request.url.path.rstrip("/") == "/api/v1/assistant/mcp":
            from .assistant_oauth import OAuthFailure, challenge_header
            try:
                response.headers["WWW-Authenticate"] = challenge_header()
            except OAuthFailure:
                # Existing local assistant keys still work without OAuth configured.
                response.headers["WWW-Authenticate"] = 'Bearer realm="FunkyFarm"'
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, exc):
        # Pydantic input values may contain passwords, document contents or tokens.
        issues = [{"field": ".".join(str(part) for part in item["loc"]), "message": item["msg"]} for item in exc.errors()]
        return error_response(422, "invalid_input", "Check the supplied fields and try again.", {"issues": issues})

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request, exc):
        detail = exc.detail
        if isinstance(detail, dict) and "error" in detail:
            error = detail["error"]
            return error_response(exc.status_code, error.get("code", "request_failed"), error.get("message", "The request failed."), error.get("details"))
        return error_response(exc.status_code, "request_failed", detail if isinstance(detail, str) else "The request could not be completed.")

    @app.exception_handler(DatabaseError)
    async def database_error(request, exc):
        if isinstance(exc, InsufficientPrivilege):
            return error_response(403, "access_denied", "Your current access does not permit this action.")
        if isinstance(exc, UniqueViolation):
            return error_response(409, "record_conflict", "This record already exists. Reload before trying again.")
        if isinstance(exc, CheckViolation):
            return error_response(409, "protected_history", "This change would alter protected history or an issued report.")
        logger.error("Database operation failed: %s", type(exc).__name__)
        return error_response(503, "database_unavailable", "The private workspace service is temporarily unavailable. Your change was not saved.")

    @app.exception_handler(Exception)
    async def unexpected_error(request, exc):
        logger.error("Request failed: %s", type(exc).__name__)
        return error_response(500, "internal_error", "The request could not be completed. Try again or contact support.")

    @app.get("/health")
    def health():
        with auth_transaction() as conn:
            conn.execute("SELECT 1")
        return {"status": "ok", "service": "funkyfarm", "version": __version__, "database": "postgresql", "isolation": "force_rls"}

    from .assistant_oauth import metadata_router
    app.include_router(metadata_router)
    app.include_router(auth_router, prefix="/api/v1")
    # Fixed feature paths precede the generic collection paths by design.
    for name in ("documents", "reporting", "imports", "collaboration", "guidance", "reconciliation",
                 "workflows", "catalogue", "connections", "fields", "satellite", "assistant_tools",
                 "assistant_mcp", "assistant_credentials", "assistant_oauth", "assistant_chat",
                 "compliance", "preflight", "regulatory", "iacs_reference", "sso"):
        module = import_module(f".{name}", __package__)
        app.include_router(module.router, prefix="/api/v1")
    app.include_router(records_router, prefix="/api/v1")
    return app


app = create_app()
