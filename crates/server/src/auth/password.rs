//! Password hashing.
//!
//! Argon2id with default parameters; the resulting PHC string encodes
//! algorithm + parameters + salt + tag so future parameter changes do
//! not require a migration.

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;

/// Hash a plaintext password into a PHC-encoded string suitable for
/// the `accounts.password_hash` column.
pub fn hash(password: &str) -> Result<String, argon2::password_hash::Error> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let phc = argon2.hash_password(password.as_bytes(), &salt)?;
    Ok(phc.to_string())
}

/// Verify a plaintext password against a stored PHC hash. Returns true
/// on match, false on mismatch, and an error if the stored hash is
/// malformed (which would be a server-side bug, not a wrong password).
pub fn verify(password: &str, phc: &str) -> Result<bool, argon2::password_hash::Error> {
    let parsed = PasswordHash::new(phc)?;
    match Argon2::default().verify_password(password.as_bytes(), &parsed) {
        Ok(()) => Ok(true),
        Err(argon2::password_hash::Error::Password) => Ok(false),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let h = hash("correct horse battery staple").unwrap();
        assert!(verify("correct horse battery staple", &h).unwrap());
        assert!(!verify("wrong password", &h).unwrap());
    }

    #[test]
    fn different_passwords_produce_different_hashes() {
        // Salt randomness implies even the same password hashes
        // differently across calls.
        let a = hash("hunter2").unwrap();
        let b = hash("hunter2").unwrap();
        assert_ne!(a, b);
        // But both verify.
        assert!(verify("hunter2", &a).unwrap());
        assert!(verify("hunter2", &b).unwrap());
    }
}
