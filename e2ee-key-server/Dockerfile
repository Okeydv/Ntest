# Сервер ключей: сборка и запуск. Собирается из каталога e2ee-key-server
# (на Railway — Root Directory = e2ee-key-server, см. README).
FROM rust:1.89-slim AS build
WORKDIR /app
# Миграции встраиваются в бинарник (sqlx::migrate!) — нужны при сборке.
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/e2ee-key-server /usr/local/bin/e2ee-key-server
# [::] — IPv6 и IPv4: частная сеть Railway работает по IPv6.
ENV BIND_ADDR=[::]:7420
USER nobody
EXPOSE 7420
CMD ["e2ee-key-server"]
