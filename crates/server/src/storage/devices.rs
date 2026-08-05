//! Device-key storage.

use uuid::Uuid;

use crocodile_protocol::ids::DeviceId;
use crocodile_protocol::keys::{device_id_from_public_key, DevicePublicKey, Signature};
use crocodile_protocol::signaling::DeviceBinding;

use crate::dispatch;
use crate::storage::Db;

/// Insert (or update) a device key for an account. Returns the device
/// id. If the device already exists for a different account, returns a
/// unique-violation error from the database.
pub async fn upsert(
    db: &Db,
    account_id: Uuid,
    device_public_key: &DevicePublicKey,
    identity_signature: &Signature,
) -> Result<DeviceId, sqlx::Error> {
    let device_id = device_id_from_public_key(device_public_key);
    dispatch!(db, |pool| {
        sqlx::query(
            r#"
            INSERT INTO devices (device_id, account_id, device_public_key, identity_signature)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (device_id) DO UPDATE
              SET identity_signature = EXCLUDED.identity_signature
              WHERE devices.account_id = EXCLUDED.account_id
            "#,
        )
        .bind(device_id.as_bytes().as_slice())
        .bind(account_id)
        .bind(device_public_key.0.as_slice())
        .bind(identity_signature.0.as_slice())
        .execute(pool)
        .await?;
    });
    Ok(device_id)
}

/// List all device bindings for a given account, in stable order.
pub async fn list_for_account(
    db: &Db,
    account_id: Uuid,
) -> Result<Vec<DeviceBinding>, sqlx::Error> {
    let rows: Vec<(Vec<u8>, Vec<u8>)> = dispatch!(db, |pool| {
        sqlx::query_as(
            r#"
            SELECT device_public_key, identity_signature
            FROM devices
            WHERE account_id = $1
            ORDER BY device_id
            "#,
        )
        .bind(account_id)
        .fetch_all(pool)
        .await?
    });

    Ok(rows
        .into_iter()
        .map(|(pk, sig)| DeviceBinding {
            device_public_key: DevicePublicKey(
                pk.try_into()
                    .expect("device_public_key column must be 32 bytes"),
            ),
            identity_signature: Signature(
                sig.try_into()
                    .expect("identity_signature column must be 64 bytes"),
            ),
        })
        .collect())
}
