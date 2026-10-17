"""Authenticated encryption for tenant-bound credentials; no development fallback."""

import json
import os

from ..models import ApiError


def encrypt_credentials(workspace_id: str, connection_id: str, values: dict):
    key = os.environ.get("FUNKYFARM_CONNECTIONS_KEY", "")
    if not key:
        raise ApiError(503, "credential_storage_unavailable", "An operator must configure the runtime encryption key before credentials can be saved.")
    try:
        from cryptography.fernet import Fernet
        cipher = Fernet(key.encode("ascii"))
    except (ImportError, ValueError, UnicodeError):
        raise ApiError(503, "credential_storage_unavailable", "Encrypted credential storage is not configured correctly.") from None
    payload = json.dumps({"workspace_id": workspace_id, "connection_id": connection_id, "credentials": values}, separators=(",", ":")).encode()
    return cipher.encrypt(payload).decode("ascii")


def decrypt_credentials(workspace_id: str, connection_id: str, ciphertext: str):
    from cryptography.fernet import Fernet, InvalidToken

    try:
        payload = json.loads(Fernet(os.environ.get("FUNKYFARM_CONNECTIONS_KEY", "").encode("ascii")).decrypt(ciphertext.encode("ascii")))
        if payload.get("workspace_id") != str(workspace_id) or payload.get("connection_id") != str(connection_id) or not isinstance(payload.get("credentials"), dict):
            raise ValueError("credential binding")
        return payload["credentials"]
    except (InvalidToken, ValueError, TypeError, KeyError, AttributeError, UnicodeError):
        raise ApiError(503, "credential_storage_unavailable", "The saved credentials could not be opened for this connection. Ask the owner to save them again.") from None
