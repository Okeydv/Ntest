#!/usr/bin/env bash
# Все тесты по очереди. Каждый набор, которому нужен сервер, идёт на пустой
# базе и свежем сервере: наборы регистрируют пользователей с одними и теми
# же именами и упираются в лимиты регистраций.
#
# Что нужно заранее:
#   - PostgreSQL и пользователь, которому можно создавать и удалять базы;
#   - собранный сервер ключей: (cd e2ee-key-server && cargo build);
#   - npm install и Chromium для Playwright: npx playwright install chromium;
#   - для тестов очистки файлов — qpdf, exiftool, Ghostscript, LibreOffice,
#     OpenJPEG, ffmpeg, webpmux и mkvinfo (см. README).
#
# База TEST_DATABASE_URL пересоздаётся перед каждым набором — не указывайте
# рабочую:
#   TEST_DATABASE_URL=postgres://postgres@localhost/nyxo_test scripts/run-all-tests.sh
# Можно запустить только часть наборов:
#   scripts/run-all-tests.sh test-ui-dialogs integration-test-access

set -u
cd "$(dirname "$0")/.."
: "${TEST_DATABASE_URL:?укажите TEST_DATABASE_URL — эту базу тесты пересоздают}"

KEY_SERVER_BIN=${KEY_SERVER_BIN:-e2ee-key-server/target/debug/e2ee-key-server}
SECRET=test-secret-at-least-32-chars-long-xx
LOGS=$(mktemp -d)

OFFLINE="test-e2ee-crypto test-metadata test-file-sandbox test-media-cleaning test-pdf-cleaning test-e2ee-crypto-browser"
ONLINE="integration-test-access integration-test-migrations integration-test-security integration-test-devices
integration-test-envelopes integration-test-uploads test-e2ee-files test-e2ee-safety test-e2ee-groups
test-e2ee-sessions test-e2ee-local-data test-e2ee-qr test-e2ee-ui test-ui-basics test-ui-dialogs"
if [ $# -gt 0 ]; then
    SELECTED=" $* "
else
    SELECTED=" $(echo $OFFLINE $ONLINE) "
fi

if [ ! -x "$KEY_SERVER_BIN" ]; then
    echo "нет сервера ключей $KEY_SERVER_BIN — соберите: (cd e2ee-key-server && cargo build)" >&2
    exit 2
fi

PIDS=()
stop_servers() {
    for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; done
    PIDS=()
}
trap stop_servers EXIT

# Пересоздать базу: подключаемся к служебной базе postgres того же сервера.
recreate_db() {
    node -e '
        const { Client } = require("pg");
        const url = new URL(process.env.TEST_DATABASE_URL);
        const name = decodeURIComponent(url.pathname.slice(1));
        url.pathname = "/postgres";
        const c = new Client({ connectionString: url.toString() });
        (async () => {
            await c.connect();
            await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
            await c.query(`CREATE DATABASE "${name}"`);
            await c.end();
        })().catch(e => { console.error(e.message); process.exit(1); });'
}

wait_for() {
    for _ in $(seq 1 60); do
        curl -s -o /dev/null -m 1 "$1" && return 0
        sleep 0.5
    done
    return 1
}

start_servers() {
    recreate_db || return 1
    DATABASE_URL="$TEST_DATABASE_URL" INTERNAL_SHARED_SECRET=$SECRET BIND_ADDR=127.0.0.1:7422 \
        "$KEY_SERVER_BIN" > "$LOGS/key-server.log" 2>&1 &
    PIDS+=($!)
    wait_for http://127.0.0.1:7422/healthz || { echo "сервер ключей не поднялся, см. $LOGS/key-server.log" >&2; return 1; }
    DATABASE_URL="$TEST_DATABASE_URL" SESSION_SECRET=test-session-secret-at-least-32-chars-long \
        INTERNAL_KEY_SERVER_SECRET=$SECRET KEY_SERVER_URL=http://127.0.0.1:7422 \
        NODE_ENV=development PORT=3006 HOST=127.0.0.1 \
        ALLOWED_ORIGINS=http://nyxotestaddress.onion ANON_SWEEP_INTERVAL_MS=2000 \
        node server.js > "$LOGS/server.log" 2>&1 &
    PIDS+=($!)
    wait_for http://127.0.0.1:3006/ || { echo "сервер не поднялся, см. $LOGS/server.log" >&2; return 1; }
}

failed=()
run() {
    local name=$1
    printf '%-32s' "$name"
    # SERVER_LOG — журнал сервера для проверок, что в него пишется;
    # TEST_ARTIFACTS — трассы и скриншоты браузерных тестов, если набор упал.
    if SERVER_LOG="$LOGS/server.log" TEST_ARTIFACTS="$LOGS/$name" \
        timeout 900 node "scripts/$name.mjs" > "$LOGS/$name.log" 2>&1; then
        echo ok
    else
        echo "FAIL — $LOGS/$name.log"
        [ -d "$LOGS/$name" ] && echo "    трассы Playwright: $LOGS/$name (npx playwright show-trace <файл>)"
        failed+=("$name")
    fi
}

for name in $OFFLINE; do
    case "$SELECTED" in *" $name "*) run "$name" ;; esac
done
for name in $ONLINE; do
    case "$SELECTED" in *" $name "*) ;; *) continue ;; esac
    if start_servers; then
        run "$name"
    else
        printf '%-32s%s\n' "$name" "FAIL — окружение не поднялось"
        failed+=("$name")
    fi
    stop_servers
done

if [ ${#failed[@]} -gt 0 ]; then
    echo "провалено: ${failed[*]}"
    exit 1
fi
echo "все наборы пройдены"
