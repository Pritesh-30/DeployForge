# DeployForge API.
#
# The backend drives Docker on the host it runs on — it starts, stops and
# inspects every deployed app — so the image carries the Docker CLI and the
# compose plugin, and the host's socket is mounted in (see docker-compose.yml).
# `pack` is included for buildpack builds while they still run on the server.

FROM docker:27.5.1-cli AS docker-cli

FROM python:3.12-slim

ARG PACK_VERSION=0.40.9

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://github.com/buildpacks/pack/releases/download/v${PACK_VERSION}/pack-v${PACK_VERSION}-linux.tgz" \
       | tar -xz -C /usr/local/bin pack

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN chmod +x docker-entrypoint.sh

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

ENTRYPOINT ["./docker-entrypoint.sh"]
