# syntax=docker/dockerfile:1

FROM node:24-trixie-slim AS source
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git libgcc-s1 python3 make g++
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.npm npm ci
ENV PCASH_TOOL_ROOT=/opt/pcash-tools

# Both images consume this exact authenticated bundle.
FROM source AS circuits
ARG TARGETARCH
# Keep the materialized CRS and content-addressed bundles in one cache so a
# cached bundle always retains the proving tools and G1 data that generated it.
RUN --mount=type=cache,id=pcash-prover-${TARGETARCH},target=/var/cache/pcash,sharing=locked \
    export PCASH_TOOL_ROOT=/var/cache/pcash/tools PCASH_CIRCUIT_CACHE=/var/cache/pcash/bundles PCASH_CIRCUIT_KAT_SET=runtime PCASH_KAT_JOBS=4 \
    && node scripts/bootstrap_prover_toolchain.mjs \
    && node scripts/circuits/bundle.mjs exec -- node --input-type=module -e \
    'import { cpSync } from "node:fs"; cpSync(process.env.PCASH_CIRCUIT_BUNDLE, "/opt/pcash-bundle", { recursive: true }); cpSync(process.env.PCASH_TOOL_ROOT, "/opt/pcash-tools", { recursive: true });'
ENV PCASH_CIRCUIT_BUNDLE=/opt/pcash-bundle PCASH_CIRCUIT_KAT_SET=runtime

FROM circuits AS browser-assets
RUN node scripts/circuits/browser_assets.mjs export \
    --bundle /opt/pcash-bundle \
    --tool-root /opt/pcash-tools \
    --release /app/assets/browser-prover-release.json \
    --output /opt/pcash-public

FROM circuits AS marketplace-source
RUN npm run build --workspace @pcash/sdk \
    && node scripts/source-verification/index.mts build \
    --definition marketplace/src/tooling/sourceVerification.mts \
    --out /opt/pcash-marketplace-source \
    --service-name "PCASH Node Operator" \
    && node --input-type=module -e \
    'import { writeFileSync } from "node:fs"; import { sourceVerificationPublication } from "./scripts/source-verification/index.mts"; const publication = sourceVerificationPublication("/opt/pcash-marketplace-source"); writeFileSync("/opt/pcash-marketplace-source/operator-publication.json", `${JSON.stringify(publication)}\n`, { flag: "wx", mode: 0o444 });'

FROM rust:1-trixie AS node-build
ARG PCASH_BUILD_JOBS=2
RUN apt-get update && apt-get install -y --no-install-recommends clang cmake pkg-config libssl-dev
COPY --from=circuits /usr/local/bin/node /usr/local/bin/node
COPY --from=circuits /app /app
COPY --from=circuits /opt/pcash-bundle /opt/pcash-bundle
ENV PCASH_CIRCUIT_BUNDLE=/opt/pcash-bundle PCASH_CIRCUIT_KAT_SET=runtime
WORKDIR /app
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target \
    cargo build --locked --release --jobs "$PCASH_BUILD_JOBS" -p pcash-node -p pcash-cli \
    && install -D target/release/pcash-node /out/pcash-node \
    && install -D target/release/pcash-cli /out/pcash-cli

FROM circuits AS runtime-deps
RUN npm prune --omit=dev --ignore-scripts

FROM node:24-trixie-slim AS node
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git libgcc-s1 libssl3t64
ENV NODE_ENV=production PCASH_TOOL_ROOT=/opt/pcash-tools \
    PCASH_PROVER_ASSETS_MANIFEST=/opt/pcash-browser-prover-manifest.json \
    PCASH_SOURCE_VERIFICATION_REPRODUCER=/app/scripts/source-verification/index.mts
WORKDIR /app
COPY --from=node-build /out/ /usr/local/bin/
COPY --from=circuits /opt/pcash-tools /opt/pcash-tools
COPY --from=runtime-deps /app/node_modules /app/node_modules
COPY --from=circuits /app/package.json /app/package.json
COPY --from=circuits /app/sdk /app/sdk
COPY --from=circuits /app/assets /app/assets
COPY --from=circuits /app/scripts/source-verification /app/scripts/source-verification
COPY --from=browser-assets /opt/pcash-public/browser-prover-manifest.json /opt/pcash-browser-prover-manifest.json
COPY --from=marketplace-source /opt/pcash-marketplace-source /opt/pcash-marketplace-source
RUN mkdir /data && chown node:node /data \
    && chown -R node:node /opt/pcash-tools/crs
USER node
RUN node scripts/source-verification/index.mts check \
    && pcash-node --help > /dev/null
EXPOSE 8645 8646 8648
ENTRYPOINT ["pcash-node"]

FROM caddy:2-alpine AS gateway
COPY compose/gateway.Caddyfile /etc/caddy/Caddyfile
COPY --from=browser-assets /opt/pcash-public/proving /srv/proving
