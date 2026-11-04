# ---- Build stage ----
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package.json bun.lock ./

# Install dependencies (including dev deps needed for TypeScript)
RUN bun install --frozen-lockfile

# Copy the rest of the project
COPY . .

# ---- Runtime stage ----
FROM oven/bun:1

# Install runtime dependencies (git for pipeline repositories, ca-certificates for TLS)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only what is needed to run the server. The server runs unbundled
# (`bun server/main.ts`): modules are discovered by a runtime scan
# of client/modules + server/modules and dynamically imported (the server
# validates dashboards against the device modules too), and the web UI is
# bundled at startup via scripts/gen_modules.ts + Bun.build.
COPY --from=builder /app/package.json /app/bun.lock ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/client ./client
COPY --from=builder /app/server ./server
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/i18n ./i18n
COPY --from=builder /app/scripts ./scripts
# tsconfig.json drives the JSX transform at bundle time (jsxFactory "m" ->
# Mithril). Without it Bun defaults to react/jsx-dev-runtime, which isn't a dep.
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# generated/ is gitignored and regenerated at startup (scripts/gen_modules.ts) —
# create it writable by the runtime user (1000:1000).
RUN mkdir -p /app/generated && chown 1000:1000 /app/generated

# Expose the default control-server port
EXPOSE 8090

# Default entrypoint — override with `command` in docker-compose
ENTRYPOINT ["bun", "server/main.ts"]
CMD ["--host", "0.0.0.0", "--port", "8090"]