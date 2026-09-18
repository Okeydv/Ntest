//! Внутренняя аутентификация.
//!
//! Этот сервис НИКОГДА не должен быть доступен напрямую из интернета —
//! клиент всегда обращается через Node, который уже проверил сессию
//! пользователя (existing express-session) и проксирует запрос сюда по
//! loopback, подставляя заголовки:
//!   X-Internal-Secret: общий секрет из .env (сравнение constant-time)
//!   X-User-Id: числовой id уже аутентифицированного пользователя
//!   X-Device-Id: id устройства, ПРИНАДЛЕЖНОСТЬ КОТОРОГО ЭТОМУ
//!                ПОЛЬЗОВАТЕЛЮ ПРОВЕРИЛ NODE
//!
//! Секрет — это defense-in-depth на случай ослабления сетевой изоляции,
//! а не основной механизм безопасности; основной механизм — bind на
//! 127.0.0.1 и отсутствие публичного порта на этот процесс.
//!
//! Про X-Device-Id отдельно: сервис не имеет доступа к таблице devices
//! (она в схеме Node) и поэтому НЕ может проверить, что устройство
//! действительно принадлежит пользователю. Эта проверка обязана делаться
//! в Node перед проксированием — см. lib/e2ee-proxy.js. Здесь заголовок
//! принимается как доверенный ровно в той же мере, что и X-User-Id.

use axum::{extract::FromRequestParts, http::request::Parts};
use subtle::ConstantTimeEq;

use crate::{error::AppError, AppState};

/// Пользователь без привязки к устройству. Остаётся для операций уровня
/// аккаунта — сейчас это полное удаление ключевого материала.
pub struct AuthedUser(pub i64);

/// Конкретное устройство конкретного пользователя. Всё, что читает или
/// пишет ключи, работает через него: после перехода на per-device модель
/// операции без device_id не имеют смысла.
pub struct AuthedDevice {
    pub user_id: i64,
    pub device_id: i64,
}

fn check_secret(parts: &Parts, state: &AppState) -> Result<(), AppError> {
    let given_secret = parts
        .headers
        .get("x-internal-secret")
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::Unauthorized)?;

    let expected = state.config.internal_shared_secret.as_bytes();
    let given = given_secret.as_bytes();
    let equal = given.len() == expected.len() && given.ct_eq(expected).unwrap_u8() == 1;
    if equal {
        Ok(())
    } else {
        Err(AppError::Unauthorized)
    }
}

fn header_i64(parts: &Parts, name: &str) -> Result<i64, AppError> {
    parts
        .headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or(AppError::Unauthorized)
}

#[axum::async_trait]
impl FromRequestParts<AppState> for AuthedUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        check_secret(parts, state)?;
        Ok(AuthedUser(header_i64(parts, "x-user-id")?))
    }
}

#[axum::async_trait]
impl FromRequestParts<AppState> for AuthedDevice {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        check_secret(parts, state)?;
        let user_id = header_i64(parts, "x-user-id")?;
        let device_id = header_i64(parts, "x-device-id")?;

        // 0 — маркер «устройство неизвестно» из миграции 0002 для строк,
        // созданных до перехода на per-device модель. Как входящее
        // значение он запрещён: иначе все клиенты, забывшие передать
        // заголовок, писали бы ключи в один общий слот.
        if device_id <= 0 {
            return Err(AppError::BadRequest(
                "x-device-id must be a positive device id".into(),
            ));
        }

        Ok(AuthedDevice { user_id, device_id })
    }
}
