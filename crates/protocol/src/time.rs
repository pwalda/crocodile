//! Wire timestamps and cache TTLs.
//!
//! All timestamps on the wire are unsigned unix seconds. Using `i64`
//! internally because durations between timestamps can legitimately be
//! negative (skew, replay checks) and we want sign without surprises.
//!
//! Note: protocol-level time is *not* a clock for security decisions
//! that require monotonicity (those use logical clocks); it exists so
//! cached server responses can carry an explicit `expires_at` per the
//! 48h offline-cache rule.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// Unix timestamp in seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[repr(transparent)]
pub struct UnixSeconds(pub i64);

impl UnixSeconds {
    /// Reads the host clock. Caller's responsibility to know that this
    /// is not monotonic and may step.
    pub fn now() -> Self {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        Self(secs)
    }

    /// Returns the raw unix seconds value.
    pub const fn get(self) -> i64 {
        self.0
    }

    /// Returns `self + delta_seconds` (saturating).
    pub fn plus_seconds(self, delta_seconds: i64) -> Self {
        Self(self.0.saturating_add(delta_seconds))
    }
}

/// Default cache TTL for signed server responses: 48 hours.
///
/// See `ARCHITECTURE.md` §8: clients may continue operating against
/// cached metadata for this long after the last successful server fetch.
pub const DEFAULT_CACHE_TTL_SECS: i64 = 48 * 60 * 60;

/// Returns true if `now <= expires_at`.
pub fn is_fresh(now: UnixSeconds, expires_at: UnixSeconds) -> bool {
    now <= expires_at
}

/// Errors out if `now > expires_at`.
pub fn check_fresh(now: UnixSeconds, expires_at: UnixSeconds) -> Result<()> {
    if is_fresh(now, expires_at) {
        Ok(())
    } else {
        Err(Error::Expired {
            expired_at_unix_secs: expires_at.get(),
            now_unix_secs: now.get(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_within_window() {
        let t = UnixSeconds(1_000_000);
        let exp = t.plus_seconds(DEFAULT_CACHE_TTL_SECS);
        assert!(is_fresh(t, exp));
        assert!(is_fresh(exp, exp));
        assert!(!is_fresh(exp.plus_seconds(1), exp));
    }

    #[test]
    fn check_fresh_surfaces_unix_seconds_in_error() {
        let t = UnixSeconds(2_000_000);
        let exp = UnixSeconds(1_000_000);
        match check_fresh(t, exp).unwrap_err() {
            Error::Expired {
                expired_at_unix_secs,
                now_unix_secs,
            } => {
                assert_eq!(expired_at_unix_secs, 1_000_000);
                assert_eq!(now_unix_secs, 2_000_000);
            }
            other => panic!("expected Expired, got {other:?}"),
        }
    }

    #[test]
    fn default_ttl_is_48h() {
        assert_eq!(DEFAULT_CACHE_TTL_SECS, 172_800);
    }
}
