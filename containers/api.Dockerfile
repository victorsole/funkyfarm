# Official library/python 3.13-slim-bookworm metadata resolved 2026-10-16.
FROM python:3.13.16-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/services/api \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    FUNKYFARM_STORAGE_ROOT=/var/lib/funkyfarm/private-documents \
    FUNKYFARM_REPORT_FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
       fonts-dejavu-core poppler-utils tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 funkyfarm \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent funkyfarm \
    && mkdir -p /var/lib/funkyfarm/private-documents \
    && chown 10001:10001 /var/lib/funkyfarm/private-documents \
    && chmod 0700 /var/lib/funkyfarm/private-documents

WORKDIR /app
COPY containers/api-requirements.lock /app/containers/api-requirements.lock
RUN python -m pip install --no-cache-dir --only-binary=:all: --no-deps \
        --requirement /app/containers/api-requirements.lock \
    && python -m pip check

# Keep the source layout: the pack resolver locates /app/packs relative to it.
COPY services/api/funkyfarm /app/services/api/funkyfarm
COPY packs /app/packs
COPY locales /app/locales
COPY shared /app/shared
COPY containers/entrypoint.py containers/healthcheck.py /app/containers/

USER 10001:10001
EXPOSE 8139
ENTRYPOINT ["python", "/app/containers/entrypoint.py"]
CMD ["api"]
