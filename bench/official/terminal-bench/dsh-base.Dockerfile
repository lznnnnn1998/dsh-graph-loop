# Reusable DSH runtime for native arm64 Terminal-Bench task images.
# Build once with the network-aware wrapper (not plain `docker build`):
#   bash bench/official/terminal-bench/build-dsh-base.sh
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/dsh \
    && curl -fsSL --retry 5 https://nodejs.org/dist/v24.9.0/node-v24.9.0-linux-arm64.tar.gz -o /tmp/node.tar.gz \
    && tar -xzf /tmp/node.tar.gz -C /opt/dsh --strip-components=1 \
    && rm /tmp/node.tar.gz
ENV PATH=/opt/dsh/bin:$PATH
RUN npm config set registry https://registry.npmjs.org \
    && npm config set fetch-retries 5 \
    && npm config set fetch-timeout 600000 \
    && npm install -g --prefix /opt/dsh @deepseek-ai/dsh@0.2.2-rc.1 pnpm@11.28.5
RUN dsh --version && pnpm --version
