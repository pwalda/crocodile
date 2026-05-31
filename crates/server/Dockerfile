# Multi-stage Dockerfile for the Crocodile coordination server.
#
# Build with (from repo root):
#   docker build -f crates/server/Dockerfile -t crocodile-server .
#
# Run alongside the existing docker-compose Postgres:
#   docker run --rm --network host \
#     -e DATABASE_URL=postgres://crocodile:crocodile_dev@localhost:5432/crocodile \
#     -e BIND_ADDR=0.0.0.0:8080 \
#     -v $PWD/.server_identity.key:/data/.server_identity.key \
#     crocodile-server

FROM rust:1.95-slim-bookworm AS builder

WORKDIR /build

# Pull system deps the workspace needs (sqlx-postgres rustls, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config libssl-dev cmake build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy the entire workspace. This isn't a layer-cache-optimal recipe
# (any source change re-fetches deps), but it's simpler and we're not
# rebuilding constantly here.
COPY Cargo.toml Cargo.lock rust-toolchain.toml .cargo ./
COPY crates ./crates

# Apply the CMake workaround the workspace sets via .cargo/config.toml.
ENV CMAKE_POLICY_VERSION_MINIMUM=3.5

RUN cargo build --release --bin crocodile-server


FROM debian:bookworm-slim

# Runtime deps: TLS roots and libssl (sqlx-rustls still wants it for
# some link paths).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /build/target/release/crocodile-server /usr/local/bin/crocodile-server
# Migrations are embedded into the binary by sqlx::migrate!, so we
# don't need to copy them.

# Persistent state — bind-mount to keep the server identity across
# container restarts. Without this, a restart generates a fresh
# identity and breaks every client's TOFU pin.
ENV SERVER_IDENTITY_PATH=/data/.server_identity.key
ENV BIND_ADDR=0.0.0.0:8080

# DATABASE_URL must be supplied at runtime — we don't bake it in.
EXPOSE 8080

CMD ["crocodile-server"]
