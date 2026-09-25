use sqlx::PgPool;

use crate::crypto::{PUBKEY_LEN, SIGNATURE_LEN};

pub struct SignedPrekeyRow {
    pub key_id: i64,
    pub public_key: [u8; PUBKEY_LEN],
    pub signature: [u8; SIGNATURE_LEN],
}

pub struct IdentityRow {
    pub identity_signing_key: [u8; PUBKEY_LEN],
    pub identity_dh_key: [u8; PUBKEY_LEN],
}

pub struct OneTimePrekeyRow {
    pub key_id: i64,
    pub public_key: [u8; PUBKEY_LEN],
}

/// Bundle одного устройства. Ключи привязаны к устройству, поэтому у
/// пользователя их столько, сколько у него активных устройств.
pub struct Bundle {
    pub device_id: i64,
    pub identity: IdentityRow,
    pub signed_prekey: SignedPrekeyRow,
    pub one_time_prekey: Option<OneTimePrekeyRow>,
}

fn to_arr32(v: Vec<u8>) -> [u8; PUBKEY_LEN] {
    // Инвариант: в БД эти колонки всегда ровно 32 байта — проверяется при
    // записи (crypto::decode_pubkey). Несовпадение длины означает порчу
    // данных на диске, а не пользовательский ввод, поэтому паника здесь
    // уместнее, чем тихая деградация.
    v.try_into().expect("corrupt row: expected 32-byte key")
}

fn to_arr64(v: Vec<u8>) -> [u8; SIGNATURE_LEN] {
    v.try_into()
        .expect("corrupt row: expected 64-byte signature")
}

/// Итог записи identity-ключей устройства.
pub enum IdentityWrite {
    /// Устройство публикует ключи впервые.
    Inserted,
    /// Повторная публикация тех же ключей — идемпотентна.
    Unchanged,
    /// У устройства уже другие ключи. Легитимно так не бывает: новая
    /// личность — это всегда новое устройство с новым device_id.
    Conflict,
}

/// Identity устройства записывается один раз и больше не меняется.
///
/// Раньше здесь был upsert, и любой, кто завладел сессией, мог молча
/// подменить ключи чужого устройства — собеседники начали бы шифровать
/// под его ключ. Клиенты такую подмену теперь ловят сами (они помнят ключ
/// устройства с первого контакта), но и сервер не должен её допускать.
pub async fn insert_identity_keys(
    pool: &PgPool,
    user_id: i64,
    device_id: i64,
    signing_key: &[u8; PUBKEY_LEN],
    dh_key: &[u8; PUBKEY_LEN],
) -> Result<IdentityWrite, sqlx::Error> {
    let inserted = sqlx::query_as::<_, (i64,)>(
        r#"
        INSERT INTO identity_keys (user_id, device_id, identity_signing_key, identity_dh_key, updated_at)
        VALUES ($1, $2, $3, $4, now())
        ON CONFLICT (user_id, device_id) DO NOTHING
        RETURNING device_id
        "#,
    )
    .bind(user_id)
    .bind(device_id)
    .bind(&signing_key[..])
    .bind(&dh_key[..])
    .fetch_optional(pool)
    .await?;
    if inserted.is_some() {
        return Ok(IdentityWrite::Inserted);
    }

    let existing = sqlx::query_as::<_, (Vec<u8>, Vec<u8>)>(
        "SELECT identity_signing_key, identity_dh_key FROM identity_keys WHERE user_id = $1 AND device_id = $2",
    )
    .bind(user_id)
    .bind(device_id)
    .fetch_one(pool)
    .await?;
    if existing.0 == signing_key[..] && existing.1 == dh_key[..] {
        Ok(IdentityWrite::Unchanged)
    } else {
        Ok(IdentityWrite::Conflict)
    }
}

/// Identity-ключи всех устройств пользователя — для сверки ключей
/// (safety numbers).
///
/// В отличие от fetch_bundles ничего не расходует: bundle забирает по
/// одноразовому prekey с каждого устройства, и тратить их ради того, чтобы
/// показать код безопасности, было бы расточительно.
pub async fn fetch_identities(
    pool: &PgPool,
    target_user_id: i64,
) -> Result<Vec<(i64, IdentityRow)>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (i64, Vec<u8>, Vec<u8>)>(
        r#"
        SELECT device_id, identity_signing_key, identity_dh_key
        FROM identity_keys
        WHERE user_id = $1
        ORDER BY device_id ASC
        "#,
    )
    .bind(target_user_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(device_id, signing, dh)| {
            (
                device_id,
                IdentityRow {
                    identity_signing_key: to_arr32(signing),
                    identity_dh_key: to_arr32(dh),
                },
            )
        })
        .collect())
}

pub async fn get_identity_signing_key(
    pool: &PgPool,
    user_id: i64,
    device_id: i64,
) -> Result<Option<[u8; PUBKEY_LEN]>, sqlx::Error> {
    let row = sqlx::query_as::<_, (Vec<u8>,)>(
        "SELECT identity_signing_key FROM identity_keys WHERE user_id = $1 AND device_id = $2",
    )
    .bind(user_id)
    .bind(device_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(k,)| to_arr32(k)))
}

pub async fn upsert_signed_prekey(
    pool: &PgPool,
    user_id: i64,
    device_id: i64,
    key_id: i64,
    public_key: &[u8; PUBKEY_LEN],
    signature: &[u8; SIGNATURE_LEN],
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO signed_prekeys (user_id, device_id, key_id, public_key, signature, created_at)
        VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (user_id, device_id) DO UPDATE
            SET key_id = EXCLUDED.key_id,
                public_key = EXCLUDED.public_key,
                signature = EXCLUDED.signature,
                created_at = now()
        "#,
    )
    .bind(user_id)
    .bind(device_id)
    .bind(key_id)
    .bind(&public_key[..])
    .bind(&signature[..])
    .execute(pool)
    .await?;
    Ok(())
}

/// Массовая загрузка one-time prekeys устройства. Дубликаты (тот же key_id
/// у того же устройства) молча игнорируются — идемпотентно на случай
/// повторной отправки клиентом. Возвращает число реально вставленных строк.
pub async fn insert_one_time_prekeys(
    pool: &PgPool,
    user_id: i64,
    device_id: i64,
    key_ids: &[i64],
    public_keys: &[Vec<u8>],
) -> Result<u64, sqlx::Error> {
    debug_assert_eq!(key_ids.len(), public_keys.len());
    let result = sqlx::query(
        r#"
        INSERT INTO one_time_prekeys (user_id, device_id, key_id, public_key)
        SELECT $1, $2, t.key_id, t.public_key
        FROM UNNEST($3::bigint[], $4::bytea[]) AS t(key_id, public_key)
        ON CONFLICT (user_id, device_id, key_id) DO NOTHING
        "#,
    )
    .bind(user_id)
    .bind(device_id)
    .bind(key_ids)
    .bind(public_keys)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

pub async fn count_one_time_prekeys(
    pool: &PgPool,
    user_id: i64,
    device_id: i64,
) -> Result<i64, sqlx::Error> {
    let (count,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM one_time_prekeys WHERE user_id = $1 AND device_id = $2",
    )
    .bind(user_id)
    .bind(device_id)
    .fetch_one(pool)
    .await?;
    Ok(count)
}

/// Атомарно собирает bundle для КАЖДОГО устройства target_user_id: identity
/// keys + текущий signed prekey + (если есть) один one-time prekey этого
/// устройства, который тут же удаляется.
///
/// Claim-and-consume идёт под `FOR UPDATE SKIP LOCKED` и отдельно на каждое
/// устройство, поэтому конкурентные запросы не выдают один и тот же OPK
/// дважды, а исчерпание пула у одного устройства не мешает остальным.
///
/// Устройства без identity-ключей или без signed prekey пропускаются: это
/// устройство, не завершившее E2EE-онбординг, и слать ему нечего. Если
/// таких оказались все — возвращается пустой вектор, и решение, считать ли
/// это 404, принимает вызывающий слой.
///
/// Принятая по threat model L4 утечка метаданных: сервер узнаёт, что
/// user_id запросил bundle target_user_id (кто с кем хочет говорить), а
/// теперь ещё и сколько у target устройств. Скрытие этого паттерна
/// потребовало бы mixnet/PIR, что прямо исключено зафиксированной моделью
/// угроз (L4, не L5/L6).
pub async fn fetch_bundles(
    pool: &PgPool,
    target_user_id: i64,
) -> Result<Vec<Bundle>, sqlx::Error> {
    let mut tx = pool.begin().await?;

    // Один запрос на identity + signed prekey: INNER JOIN сам отбрасывает
    // устройства с неполным материалом.
    let rows = sqlx::query_as::<_, (i64, Vec<u8>, Vec<u8>, i64, Vec<u8>, Vec<u8>)>(
        r#"
        SELECT ik.device_id,
               ik.identity_signing_key,
               ik.identity_dh_key,
               sp.key_id,
               sp.public_key,
               sp.signature
        FROM identity_keys ik
        JOIN signed_prekeys sp
          ON sp.user_id = ik.user_id AND sp.device_id = ik.device_id
        WHERE ik.user_id = $1
        ORDER BY ik.device_id ASC
        "#,
    )
    .bind(target_user_id)
    .fetch_all(&mut *tx)
    .await?;

    let mut bundles = Vec::with_capacity(rows.len());
    for (device_id, signing_key, dh_key, spk_key_id, spk_pub, spk_sig) in rows {
        let otpk = sqlx::query_as::<_, (i64, i64, Vec<u8>)>(
            r#"
            DELETE FROM one_time_prekeys
            WHERE id = (
                SELECT id FROM one_time_prekeys
                WHERE user_id = $1 AND device_id = $2
                ORDER BY id ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id, key_id, public_key
            "#,
        )
        .bind(target_user_id)
        .bind(device_id)
        .fetch_optional(&mut *tx)
        .await?;

        bundles.push(Bundle {
            device_id,
            identity: IdentityRow {
                identity_signing_key: to_arr32(signing_key),
                identity_dh_key: to_arr32(dh_key),
            },
            signed_prekey: SignedPrekeyRow {
                key_id: spk_key_id,
                public_key: to_arr32(spk_pub),
                signature: to_arr64(spk_sig),
            },
            one_time_prekey: otpk.map(|(_, key_id, public_key)| OneTimePrekeyRow {
                key_id,
                public_key: to_arr32(public_key),
            }),
        });
    }

    tx.commit().await?;
    Ok(bundles)
}

/// Удаление ключевого материала ОДНОГО устройства — отзыв устройства.
///
/// Отзыв устройства обязан сопровождаться сменой групповых ключей у всех
/// участников общих групп: в схеме sender keys отозванное устройство иначе
/// продолжит расшифровывать групповые сообщения теми ключами, что у него
/// уже есть. Здесь удаляется только ключевой материал; ротацию инициирует
/// Node, у которого есть состав групп.
pub async fn delete_device_keys(
    pool: &PgPool,
    user_id: i64,
    device_id: i64,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM one_time_prekeys WHERE user_id = $1 AND device_id = $2")
        .bind(user_id)
        .bind(device_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM signed_prekeys WHERE user_id = $1 AND device_id = $2")
        .bind(user_id)
        .bind(device_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM identity_keys WHERE user_id = $1 AND device_id = $2")
        .bind(user_id)
        .bind(device_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Полное удаление ключевого материала пользователя по всем устройствам —
/// используется при удалении аккаунта, часть требований по эфемерности из
/// threat model.
pub async fn delete_all_keys(pool: &PgPool, user_id: i64) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM one_time_prekeys WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM signed_prekeys WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM identity_keys WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
