use axum::{
    extract::{Path, State},
    Json,
};

use crate::{
    auth::{AuthedDevice, AuthedUser},
    crypto::{decode_pubkey, decode_signature, encode_b64},
    db,
    error::AppError,
    models::*,
    AppState,
};

pub async fn health() -> &'static str {
    "ok"
}

/// PUT /internal/v1/keys/identity
/// Регистрирует identity-ключи ОДНОГО устройства. У пользователя столько
/// identity, сколько у него активных устройств. Заменить ключи уже
/// зарегистрированного устройства нельзя — 409 (см. db::insert_identity_keys).
pub async fn put_identity_keys(
    State(state): State<AppState>,
    device: AuthedDevice,
    Json(req): Json<IdentityKeysRequest>,
) -> Result<Json<OkResponse>, AppError> {
    let signing_key = decode_pubkey("identity_signing_key", &req.identity_signing_key)?;
    let dh_key = decode_pubkey("identity_dh_key", &req.identity_dh_key)?;

    match db::insert_identity_keys(
        &state.pool,
        device.user_id,
        device.device_id,
        &signing_key,
        &dh_key,
    )
    .await?
    {
        db::IdentityWrite::Inserted | db::IdentityWrite::Unchanged => Ok(Json(OkResponse::ok())),
        db::IdentityWrite::Conflict => Err(AppError::Conflict(
            "identity keys of a device cannot be replaced; register a new device".into(),
        )),
    }
}

/// PUT /internal/v1/keys/signed-prekey
/// Ротация Signed PreKey. Требует, чтобы identity-ключи уже были
/// зарегистрированы (иначе нечем проверить подпись — 409).
pub async fn put_signed_prekey(
    State(state): State<AppState>,
    device: AuthedDevice,
    Json(req): Json<SignedPrekeyRequest>,
) -> Result<Json<OkResponse>, AppError> {
    let public_key = decode_pubkey("public_key", &req.public_key)?;
    let signature = decode_signature("signature", &req.signature)?;

    // Подпись проверяется identity-ключом ЭТОГО устройства: подписывать
    // свой signed prekey ключом другого устройства нельзя.
    let signing_key = db::get_identity_signing_key(&state.pool, device.user_id, device.device_id)
        .await?
        .ok_or_else(|| {
            AppError::Conflict("identity keys must be registered before a signed prekey".into())
        })?;

    crate::crypto::verify_signed_prekey(&signing_key, &public_key, &signature)?;

    db::upsert_signed_prekey(
        &state.pool,
        device.user_id,
        device.device_id,
        req.key_id,
        &public_key,
        &signature,
    )
    .await?;
    Ok(Json(OkResponse::ok()))
}

/// POST /internal/v1/keys/one-time-prekeys
/// Пополнение пула one-time prekeys. Дубликаты key_id тихо игнорируются.
pub async fn post_one_time_prekeys(
    State(state): State<AppState>,
    device: AuthedDevice,
    Json(req): Json<OneTimePrekeysRequest>,
) -> Result<Json<OneTimePrekeysUploadResponse>, AppError> {
    if req.keys.is_empty() {
        return Err(AppError::BadRequest("keys must not be empty".into()));
    }
    if req.keys.len() > state.config.max_otpk_batch {
        return Err(AppError::BadRequest(format!(
            "batch too large: max {} keys per request",
            state.config.max_otpk_batch
        )));
    }

    let mut key_ids = Vec::with_capacity(req.keys.len());
    let mut public_keys = Vec::with_capacity(req.keys.len());
    for item in &req.keys {
        let pk = decode_pubkey("keys[].public_key", &item.public_key)?;
        key_ids.push(item.key_id);
        public_keys.push(pk.to_vec());
    }

    let inserted = db::insert_one_time_prekeys(
        &state.pool,
        device.user_id,
        device.device_id,
        &key_ids,
        &public_keys,
    )
    .await?;
    Ok(Json(OneTimePrekeysUploadResponse {
        success: true,
        inserted,
    }))
}

/// GET /internal/v1/keys/one-time-prekeys/count
/// Позволяет Node/клиенту решить, пора ли пополнять пул OPK.
pub async fn get_one_time_prekey_count(
    State(state): State<AppState>,
    device: AuthedDevice,
) -> Result<Json<OneTimePrekeyCountResponse>, AppError> {
    let count =
        db::count_one_time_prekeys(&state.pool, device.user_id, device.device_id).await?;
    Ok(Json(OneTimePrekeyCountResponse {
        device_id: device.device_id,
        count,
    }))
}

/// GET /internal/v1/keys/bundle/:target_user_id
/// Выдаёт НАБОР bundle — по одному на каждое устройство target_user_id, у
/// которого ключевой материал полон, атомарно забирая по одному one-time
/// prekey из пула каждого устройства.
///
/// Отправитель обязан зашифровать сообщение для каждого элемента набора:
/// пропущенное устройство означает, что на нём сообщение не прочитается.
///
/// 404 отдаётся, когда ни одно устройство пользователя не завершило
/// E2EE-онбординг — так сохраняется прежняя семантика «у этого получателя
/// шифрованную сессию не установить».
///
/// Принятая по threat model L4 утечка метаданных: сервер узнаёт, что
/// user_id запросил bundle target_user_id (кто с кем хочет говорить), а
/// теперь ещё и сколько у получателя устройств. Скрытие этого паттерна
/// потребовало бы mixnet/PIR, что прямо исключено зафиксированной моделью
/// угроз (L4, не L5/L6).
pub async fn get_bundle(
    State(state): State<AppState>,
    AuthedUser(_requesting_user_id): AuthedUser,
    Path(target_user_id): Path<i64>,
) -> Result<Json<BundlesResponse>, AppError> {
    let bundles = db::fetch_bundles(&state.pool, target_user_id).await?;
    if bundles.is_empty() {
        return Err(AppError::NotFound);
    }

    Ok(Json(BundlesResponse {
        bundles: bundles
            .into_iter()
            .map(|b| DeviceBundle {
                device_id: b.device_id,
                identity_signing_key: encode_b64(&b.identity.identity_signing_key),
                identity_dh_key: encode_b64(&b.identity.identity_dh_key),
                signed_prekey: SignedPrekeyDto {
                    key_id: b.signed_prekey.key_id,
                    public_key: encode_b64(&b.signed_prekey.public_key),
                    signature: encode_b64(&b.signed_prekey.signature),
                },
                one_time_prekey: b.one_time_prekey.map(|o| OneTimePrekeyDto {
                    key_id: o.key_id,
                    public_key: encode_b64(&o.public_key),
                }),
            })
            .collect(),
    }))
}

/// GET /internal/v1/keys/identities/:target_user_id
/// Identity-ключи всех устройств пользователя, без расхода prekeys.
/// Пустой список — не ошибка: у пользователя может не быть ни одного
/// устройства с ключами, и код безопасности тогда просто не из чего строить.
pub async fn get_identities(
    State(state): State<AppState>,
    AuthedUser(_requesting_user_id): AuthedUser,
    Path(target_user_id): Path<i64>,
) -> Result<Json<IdentitiesResponse>, AppError> {
    let rows = db::fetch_identities(&state.pool, target_user_id).await?;
    Ok(Json(IdentitiesResponse {
        devices: rows
            .into_iter()
            .map(|(device_id, identity)| DeviceIdentity {
                device_id,
                identity_signing_key: encode_b64(&identity.identity_signing_key),
                identity_dh_key: encode_b64(&identity.identity_dh_key),
            })
            .collect(),
    }))
}

/// DELETE /internal/v1/keys/device
/// Отзыв устройства: удаляет ключевой материал только этого устройства,
/// остальные устройства пользователя не затрагиваются.
///
/// Внимание: одного удаления ключей недостаточно. В схеме sender keys
/// отозванное устройство продолжит расшифровывать групповые сообщения
/// теми групповыми ключами, что уже получило, поэтому Node обязан
/// инициировать ротацию sender key у всех участников общих групп.
pub async fn delete_device_keys(
    State(state): State<AppState>,
    device: AuthedDevice,
) -> Result<Json<OkResponse>, AppError> {
    db::delete_device_keys(&state.pool, device.user_id, device.device_id).await?;
    Ok(Json(OkResponse::ok()))
}

/// DELETE /internal/v1/keys
/// Полная очистка ключевого материала вызывающего пользователя по всем
/// устройствам (например, при удалении аккаунта). Часть требований по
/// эфемерности.
pub async fn delete_keys(
    State(state): State<AppState>,
    AuthedUser(user_id): AuthedUser,
) -> Result<Json<OkResponse>, AppError> {
    db::delete_all_keys(&state.pool, user_id).await?;
    Ok(Json(OkResponse::ok()))
}
