"""Voice typing is optional: off unless the server enables it, and never available signed out."""

import httpx


def test_voice_typing_is_off_unless_enabled(farmers, service_url):
    user = farmers("Voice typing reader")
    status = user.get("/speech/status").json()
    assert status["enabled"] is False and "ga" not in status["languages"] and "es" in status["languages"]
    user.post("/speech/transcribe?language=es", content=b"\x1aE\xdf\xa3" + bytes(400), headers={"Content-Type": "audio/webm"}, expected=503)
    signed_out = httpx.post(service_url + "/speech/transcribe?language=es", content=bytes(400), headers={"Content-Type": "audio/webm"}, timeout=10)
    assert signed_out.status_code in {401, 403}
