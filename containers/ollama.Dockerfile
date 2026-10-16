# Official Ollama metadata resolved 2026-10-16. Preserve upstream CPU binaries;
# GPU payloads stay on the CI builder and are not published to this CPU host.
FROM ollama/ollama:0.40.5@sha256:5d3a2f25f9825628daba94dc0b1d421c7d57d6c03ae5faa9ba050e058bab8241 AS upstream
RUN mkdir /cpu \
    && find /usr/lib/ollama -maxdepth 1 \( -type f -o -type l \) -exec cp -a -- '{}' /cpu/ \; \
    && test -f /cpu/GO_LICENSE \
    && test -x /cpu/llama-server

FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates python3 libgomp1 libstdc++6 libopenblas0 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 funkyfarm-model \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp funkyfarm-model \
    && mkdir -p /models /opt/funkyfarm-model \
    && chown 10001:10001 /models \
    && chmod 0700 /models
COPY --from=upstream /usr/bin/ollama /usr/bin/ollama
COPY --from=upstream /cpu/ /usr/lib/ollama/
ADD --checksum=sha256:5934ed2ce0d15154bcdb9c85203210abac0da4314af34081e36df4599f90b226 https://raw.githubusercontent.com/ollama/ollama/v0.40.5/LICENSE /opt/funkyfarm-model/LICENSE-ollama
COPY containers/ollama-model.json containers/ollama_bootstrap.py /opt/funkyfarm-model/
ENV HOME=/tmp OLLAMA_MODELS=/models OLLAMA_HOST=0.0.0.0:11434 \
    OLLAMA_NO_CLOUD=1 OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1 \
    OLLAMA_MAX_QUEUE=1 OLLAMA_CONTEXT_LENGTH=4096 OLLAMA_KEEP_ALIVE=60s \
    OLLAMA_DEBUG=false CUDA_VISIBLE_DEVICES=-1 PYTHONDONTWRITEBYTECODE=1
LABEL org.opencontainers.image.title="FunkyFarm CPU-only Ollama derivative" \
      org.opencontainers.image.licenses="MIT" \
      eu.funkyfarm.upstream.ollama="0.40.5@sha256:5d3a2f25f9825628daba94dc0b1d421c7d57d6c03ae5faa9ba050e058bab8241"
USER 10001:10001
ENTRYPOINT ["python3", "/opt/funkyfarm-model/ollama_bootstrap.py"]
CMD ["serve"]
