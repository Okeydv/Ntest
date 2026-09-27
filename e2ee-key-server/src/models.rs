use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct IdentityKeysRequest {
    pub identity_signing_key: String, // base64, Ed25519 pub, 32 bytes
    pub identity_dh_key: String,      // base64, X25519 pub, 32 bytes
    /// base64, Ed25519-подпись IDENTITY_DH_CONTEXT || identity_dh_key.
    /// Необязательна только для совместимости со старыми клиентами.
    #[serde(default)]
    pub identity_dh_signature: Option<String>,
}

#[derive(Deserialize)]
pub struct SignedPrekeyRequest {
    pub key_id: i64,
    pub public_key: String, // base64, X25519 pub, 32 bytes
    pub signature: String,  // base64, Ed25519 signature, 64 bytes
}

#[derive(Deserialize)]
pub struct OneTimePrekeyItem {
    pub key_id: i64,
    pub public_key: String, // base64, X25519 pub, 32 bytes
}

#[derive(Deserialize)]
pub struct OneTimePrekeysRequest {
    pub keys: Vec<OneTimePrekeyItem>,
}

#[derive(Serialize)]
pub struct OkResponse {
    pub success: bool,
}

impl OkResponse {
    pub fn ok() -> Self {
        Self { success: true }
    }
}

#[derive(Serialize)]
pub struct OneTimePrekeysUploadResponse {
    pub success: bool,
    pub inserted: u64,
}

#[derive(Serialize)]
pub struct OneTimePrekeyCountResponse {
    pub device_id: i64,
    pub count: i64,
}

#[derive(Serialize)]
pub struct SignedPrekeyDto {
    pub key_id: i64,
    pub public_key: String,
    pub signature: String,
}

#[derive(Serialize)]
pub struct OneTimePrekeyDto {
    pub key_id: i64,
    pub public_key: String,
}

/// Bundle ОДНОГО устройства получателя.
#[derive(Serialize)]
pub struct DeviceBundle {
    /// Клиент обязан хранить сессию в привязке к этому id: адрес сессии —
    /// это (user_id, device_id), а не один user_id.
    pub device_id: i64,
    pub identity_signing_key: String,
    pub identity_dh_key: String,
    pub identity_dh_signature: Option<String>,
    pub signed_prekey: SignedPrekeyDto,
    /// None если у устройства временно кончились one-time prekeys.
    /// X3DH в этом случае деградирует (пропускается DH-шаг с OPK) —
    /// сессия остаётся безопасной, но теряется часть forward secrecy
    /// для самого первого сообщения. Клиент должен показать это как
    /// повод срочно пополнить пул своих OPK на стороне получателя.
    pub one_time_prekey: Option<OneTimePrekeyDto>,
}

/// Ответ на запрос bundle: набор по всем устройствам получателя, у которых
/// ключевой материал полон.
///
/// Отправитель обязан зашифровать сообщение для КАЖДОГО элемента этого
/// набора — иначе на части устройств получателя сообщение не расшифруется.
/// В схеме sender keys через этот же набор раздаются и групповые ключи.
#[derive(Serialize)]
pub struct BundlesResponse {
    pub bundles: Vec<DeviceBundle>,
}

/// Identity-ключи одного устройства — без prekeys.
#[derive(Serialize)]
pub struct DeviceIdentity {
    pub device_id: i64,
    pub identity_signing_key: String,
    pub identity_dh_key: String,
    pub identity_dh_signature: Option<String>,
}

/// Ответ на запрос identity-ключей: по всем устройствам пользователя.
#[derive(Serialize)]
pub struct IdentitiesResponse {
    pub devices: Vec<DeviceIdentity>,
}
