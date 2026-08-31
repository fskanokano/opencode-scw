# opencode-scw — Scaleway Serverless Container variant
#
# Why a container? Scaleway Functions buffer responses, so token streaming is
# only delivered when the agent finishes and the opencode web UI cannot update
# live. A container gets real SSE streaming and a fully working web UI.
#
# Build (requires the linux binary, fetched by the build script):
#   bash scripts/build-function.sh
#   docker build -t opencode-scw .
#
# Deploy to Scaleway Serverless Containers, HTTP port 8080 (the platform
# injects PORT, or you can override with ENV PORT=8080).
#
# The handler.js code is identical — it detects the PORT env var and starts a
# standalone streaming HTTP server.

FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

COPY function/package.json ./
COPY function/handler.js ./
COPY function/opencode ./opencode

RUN chmod +x ./opencode && mkdir -p /data && rm -rf /app/workspace

# opencode writes state under $HOME — point it at a writable volume
ENV OPENCODE_DATA_HOME=/data/home
ENV OPENCODE_WORKSPACE=/data/workspace

EXPOSE 8080
CMD ["node", "handler.js"]
