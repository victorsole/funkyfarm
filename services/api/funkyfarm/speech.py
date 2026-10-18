"""Optional local speech-to-text with Whisper (faster-whisper, MIT), for typing by voice.

Audio is read into memory, transcribed on this server and discarded: it is never stored and
never sent to another service. The text goes back to the person, who checks it before anything
is saved. Disabled unless FUNKYFARM_WHISPER_ENABLED=true and faster-whisper is installed.
"""

from io import BytesIO
import os
import threading

from fastapi import APIRouter, Depends, Query, Request
from starlette.concurrency import run_in_threadpool

from .models import ApiError
from .security import Session, require_session

router = APIRouter(tags=["speech"])
MAX_AUDIO_BYTES = 3_000_000
MAX_SECONDS = 31.0
AUDIO_TYPES = ("audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/aac")
# Whisper covers 23 of the 24 EU official languages; Irish (ga) is not among its languages.
EU_LANGUAGES = {"bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it", "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es", "sv"}
_model = None
_model_lock = threading.Lock()
_busy = threading.BoundedSemaphore(1)


def settings():
    enabled = os.environ.get("FUNKYFARM_WHISPER_ENABLED", "false").lower() == "true"
    return {"enabled": enabled, "model": os.environ.get("FUNKYFARM_WHISPER_MODEL", "small"),
            "directory": os.environ.get("FUNKYFARM_WHISPER_MODEL_DIR") or None}


def installed():
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        return False
    return True


def model():
    global _model
    with _model_lock:
        if _model is None:
            from faster_whisper import WhisperModel
            config = settings()
            _model = WhisperModel(config["model"], device="cpu", compute_type="int8", download_root=config["directory"])
        return _model


def transcribe(audio: bytes, language: str | None):
    if not _busy.acquire(timeout=20):
        raise ApiError(429, "speech_busy", "Voice typing is busy. Try again in a moment or type instead.")
    try:
        try:
            segments, info = model().transcribe(BytesIO(audio), language=language, beam_size=1, vad_filter=True, condition_on_previous_text=False)
            if info.duration > MAX_SECONDS:
                raise ApiError(422, "audio_too_long", "Keep a voice message under 30 seconds.")
            if info.language not in EU_LANGUAGES:
                raise ApiError(422, "language_not_supported", "Voice typing did not recognise an EU language it supports. Please type instead.")
            text = " ".join(segment.text.strip() for segment in segments).strip()
        except ApiError:
            raise
        except Exception:
            raise ApiError(422, "audio_unreadable", "The recording could not be read. Try again or type instead.") from None
        return {"text": text[:4000], "language": info.language, "duration_s": round(info.duration, 1)}
    finally:
        _busy.release()


@router.get("/speech/status")
def status(session: Session = Depends(require_session)):
    config = settings()
    return {"enabled": config["enabled"] and installed(), "model": config["model"], "languages": sorted(EU_LANGUAGES),
            "notice": "Voice is transcribed on Funkyfarm's server with Whisper and then deleted. Check the text before saving."}


@router.post("/speech/transcribe")
async def transcribe_audio(request: Request, language: str = Query("auto", min_length=2, max_length=5),
                           session: Session = Depends(require_session)):
    if not (settings()["enabled"] and installed()):
        raise ApiError(503, "speech_disabled", "Voice typing is not switched on for this Funkyfarm server.")
    # "auto" lets Whisper detect which supported EU language the person spoke.
    code = language.lower().split("-")[0]
    if code != "auto" and code not in EU_LANGUAGES:
        raise ApiError(422, "language_not_supported", "Voice typing does not support this language yet. Please type instead.")
    media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if media_type not in AUDIO_TYPES:
        raise ApiError(415, "audio_type", "Send a short audio recording.")
    audio = bytearray()
    async for chunk in request.stream():
        audio.extend(chunk)
        if len(audio) > MAX_AUDIO_BYTES:
            raise ApiError(413, "audio_too_large", "Keep a voice message under 30 seconds.")
    if len(audio) < 200:
        raise ApiError(422, "audio_empty", "The recording was empty. Hold the button and speak.")
    return await run_in_threadpool(transcribe, bytes(audio), None if code == "auto" else code)
