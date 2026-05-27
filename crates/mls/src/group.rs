//! A handle to an MLS group, owned by a single device.
//!
//! Each [`Group`] borrows or owns an [`Identity`] and uses an
//! `OpenMlsRustCrypto` provider for cryptography and in-memory state.
//! Persistence is not done here — group state lives in the provider's
//! in-memory storage for v1.

use openmls::framing::{MlsMessageBodyIn, MlsMessageIn, ProcessedMessageContent};
use openmls::group::{
    GroupId, MlsGroup as OpenMlsGroup, MlsGroupCreateConfig, MlsGroupJoinConfig, StagedWelcome,
};
use openmls_rust_crypto::OpenMlsRustCrypto;
use tls_codec::Deserialize as TlsDeserialize;

use crocodile_protocol::ids::DeviceId;
use crocodile_protocol::mls::{GroupEpoch, MlsCiphertext, MlsCommit, MlsWelcome};

use crate::error::{MlsError, Result};
use crate::identity::Identity;
use crate::key_package::{welcome_to_protocol, KeyPackage};

/// Output of an add-member operation: a commit to broadcast to all
/// existing members, plus a welcome to send privately to the new
/// member.
#[derive(Debug, Clone)]
pub struct AddOutcome {
    /// The MLS Commit message advancing this group's epoch. Send to
    /// all existing members.
    pub commit: MlsCommit,
    /// The MLS Welcome message admitting the new member. Send only
    /// to the joining peer.
    pub welcome: MlsWelcome,
}

/// A group handle. Tied to a single provider for crypto state.
pub struct Group {
    inner: OpenMlsGroup,
}

impl std::fmt::Debug for Group {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Group")
            .field("epoch", &self.epoch())
            .field("member_count", &self.inner.members().count())
            .finish()
    }
}

impl Group {
    /// Create a brand-new group as the sole initial member.
    ///
    /// We embed the ratchet tree in Welcomes so a new joiner does not
    /// need a separate sideband fetch to recover it. Trade-off:
    /// slightly larger Welcomes. Acceptable for our scale (≤50 per
    /// room).
    pub fn create(
        provider: &OpenMlsRustCrypto,
        identity: &Identity,
        group_id: &[u8],
    ) -> Result<Self> {
        let config = MlsGroupCreateConfig::builder()
            .use_ratchet_tree_extension(true)
            .build();
        let inner = OpenMlsGroup::new_with_group_id(
            provider,
            &identity.signature_keys,
            &config,
            GroupId::from_slice(group_id),
            identity.credential_with_key(),
        )
        .map_err(|e| MlsError::OpenMls(format!("create group: {e:?}")))?;
        Ok(Self { inner })
    }

    /// Join a group from an MLS Welcome message.
    pub fn join_from_welcome(
        provider: &OpenMlsRustCrypto,
        _identity: &Identity,
        welcome: &MlsWelcome,
    ) -> Result<Self> {
        let mls_in: MlsMessageIn = MlsMessageIn::tls_deserialize(&mut &welcome.0[..])
            .map_err(|e| MlsError::TlsCodec(format!("welcome deserialize: {e:?}")))?;
        // `into_welcome()` is feature-gated to test-utils in openmls
        // 0.6; pattern-match on the body to do the same conversion in
        // production code.
        let welcome_struct = match mls_in.extract() {
            MlsMessageBodyIn::Welcome(w) => w,
            _ => return Err(MlsError::UnexpectedMessage("expected Welcome")),
        };
        let staged = StagedWelcome::new_from_welcome(
            provider,
            &MlsGroupJoinConfig::default(),
            welcome_struct,
            None,
        )
        .map_err(|e| MlsError::OpenMls(format!("staged welcome: {e:?}")))?;
        let inner = staged
            .into_group(provider)
            .map_err(|e| MlsError::OpenMls(format!("into group: {e:?}")))?;
        Ok(Self { inner })
    }

    /// Current epoch.
    pub fn epoch(&self) -> GroupEpoch {
        GroupEpoch(self.inner.epoch().as_u64())
    }

    /// Members' device ids in stable order.
    pub fn members(&self) -> Vec<DeviceId> {
        self.inner
            .members()
            .filter_map(|m| {
                let bytes = m.credential.serialized_content();
                let arr: [u8; 32] = bytes.try_into().ok()?;
                Some(DeviceId::from_bytes(arr))
            })
            .collect()
    }

    /// Add `key_package`'s owner to the group. Returns the Commit
    /// (broadcast to existing members) and Welcome (send to joiner).
    pub fn add_member(
        &mut self,
        provider: &OpenMlsRustCrypto,
        identity: &Identity,
        key_package: KeyPackage,
    ) -> Result<AddOutcome> {
        let kp = key_package.into_openmls(provider)?;
        let (commit_msg, welcome_msg, _group_info) = self
            .inner
            .add_members(provider, &identity.signature_keys, &[kp])
            .map_err(|e| MlsError::OpenMls(format!("add_members: {e:?}")))?;

        // After producing the commit/welcome, the *adder* must apply
        // the pending commit to advance their own epoch. Otherwise the
        // adder's group state would lag behind the new member's.
        self.inner
            .merge_pending_commit(provider)
            .map_err(|e| MlsError::OpenMls(format!("merge pending commit: {e:?}")))?;

        let commit_bytes = commit_msg
            .to_bytes()
            .map_err(|e| MlsError::TlsCodec(format!("commit serialize: {e:?}")))?;
        let welcome = welcome_to_protocol(welcome_msg)?;

        Ok(AddOutcome {
            commit: MlsCommit(commit_bytes),
            welcome,
        })
    }

    /// Process an incoming Commit from another member. Advances this
    /// group's epoch on success.
    pub fn process_commit(
        &mut self,
        provider: &OpenMlsRustCrypto,
        commit: &MlsCommit,
    ) -> Result<()> {
        let mls_in = MlsMessageIn::tls_deserialize(&mut &commit.0[..])
            .map_err(|e| MlsError::TlsCodec(format!("commit deserialize: {e:?}")))?;
        let protocol_msg = mls_in
            .try_into_protocol_message()
            .map_err(|_| MlsError::UnexpectedMessage("expected Commit (public or private)"))?;
        let processed = self
            .inner
            .process_message(provider, protocol_msg)
            .map_err(|e| MlsError::OpenMls(format!("process commit: {e:?}")))?;
        match processed.into_content() {
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                self.inner
                    .merge_staged_commit(provider, *staged)
                    .map_err(|e| MlsError::OpenMls(format!("merge staged commit: {e:?}")))?;
                Ok(())
            }
            _ => Err(MlsError::UnexpectedMessage("expected staged commit")),
        }
    }

    /// Encrypt an application payload under the current epoch.
    pub fn encrypt(
        &mut self,
        provider: &OpenMlsRustCrypto,
        identity: &Identity,
        payload: &[u8],
    ) -> Result<MlsCiphertext> {
        let msg_out = self
            .inner
            .create_message(provider, &identity.signature_keys, payload)
            .map_err(|e| MlsError::OpenMls(format!("create_message: {e:?}")))?;
        let bytes = msg_out
            .to_bytes()
            .map_err(|e| MlsError::TlsCodec(format!("application msg serialize: {e:?}")))?;
        Ok(MlsCiphertext(bytes))
    }

    /// Decrypt an application payload received from another member.
    pub fn decrypt(
        &mut self,
        provider: &OpenMlsRustCrypto,
        ciphertext: &MlsCiphertext,
    ) -> Result<Vec<u8>> {
        let mls_in = MlsMessageIn::tls_deserialize(&mut &ciphertext.0[..])
            .map_err(|e| MlsError::TlsCodec(format!("appmsg deserialize: {e:?}")))?;
        let protocol_msg = mls_in
            .try_into_protocol_message()
            .map_err(|_| MlsError::UnexpectedMessage("expected application message"))?;
        let processed = self
            .inner
            .process_message(provider, protocol_msg)
            .map_err(|e| MlsError::OpenMls(format!("process appmsg: {e:?}")))?;
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(app) => Ok(app.into_bytes()),
            _ => Err(MlsError::UnexpectedMessage("expected application message")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Identity;
    use openmls_rust_crypto::OpenMlsRustCrypto;

    fn device(byte: u8) -> DeviceId {
        DeviceId::from_bytes([byte; 32])
    }

    #[test]
    fn two_party_roundtrip() {
        // Alice's side
        let alice_provider = OpenMlsRustCrypto::default();
        let alice_identity = Identity::generate(device(1), &alice_provider).unwrap();

        // Bob's side
        let bob_provider = OpenMlsRustCrypto::default();
        let bob_identity = Identity::generate(device(2), &bob_provider).unwrap();

        // Bob publishes a key package.
        let bob_kp = KeyPackage::generate(&bob_identity, &bob_provider).unwrap();
        // Roundtrip the kp through bytes — simulating sending it via
        // signaling to Alice.
        let kp_for_alice =
            KeyPackage::from_bytes(bob_kp.as_bytes(), &alice_provider).unwrap();

        // Alice creates a group and adds Bob.
        let mut alice_group =
            Group::create(&alice_provider, &alice_identity, b"test-room").unwrap();
        let outcome = alice_group
            .add_member(&alice_provider, &alice_identity, kp_for_alice)
            .unwrap();

        // After the add, Alice is at epoch 1 (was epoch 0 on create).
        assert_eq!(alice_group.epoch().0, 1);

        // Bob joins from the welcome.
        let mut bob_group =
            Group::join_from_welcome(&bob_provider, &bob_identity, &outcome.welcome).unwrap();
        assert_eq!(bob_group.epoch().0, 1, "bob should join at the post-add epoch");

        // Members match on both sides.
        let mut alice_members = alice_group.members();
        let mut bob_members = bob_group.members();
        alice_members.sort_by_key(|d| *d.as_bytes());
        bob_members.sort_by_key(|d| *d.as_bytes());
        assert_eq!(alice_members, bob_members);
        assert_eq!(alice_members.len(), 2);

        // Roundtrip: Alice encrypts → Bob decrypts.
        let ct = alice_group
            .encrypt(&alice_provider, &alice_identity, b"hello bob")
            .unwrap();
        let pt = bob_group.decrypt(&bob_provider, &ct).unwrap();
        assert_eq!(&pt, b"hello bob");

        // And the other direction.
        let ct = bob_group
            .encrypt(&bob_provider, &bob_identity, b"hi alice")
            .unwrap();
        let pt = alice_group.decrypt(&alice_provider, &ct).unwrap();
        assert_eq!(&pt, b"hi alice");
    }

    #[test]
    fn three_party_add_and_commit_propagation() {
        // Set up three providers + identities.
        let alice_provider = OpenMlsRustCrypto::default();
        let bob_provider = OpenMlsRustCrypto::default();
        let carol_provider = OpenMlsRustCrypto::default();
        let alice = Identity::generate(device(1), &alice_provider).unwrap();
        let bob = Identity::generate(device(2), &bob_provider).unwrap();
        let carol = Identity::generate(device(3), &carol_provider).unwrap();

        // Alice creates the group, adds Bob.
        let bob_kp = KeyPackage::generate(&bob, &bob_provider).unwrap();
        let mut a_group = Group::create(&alice_provider, &alice, b"abc-room").unwrap();
        let bob_join = a_group
            .add_member(
                &alice_provider,
                &alice,
                KeyPackage::from_bytes(bob_kp.as_bytes(), &alice_provider).unwrap(),
            )
            .unwrap();
        let mut b_group =
            Group::join_from_welcome(&bob_provider, &bob, &bob_join.welcome).unwrap();

        // Alice then adds Carol. Bob must process the resulting commit
        // to advance to the same epoch as Alice and Carol.
        let carol_kp = KeyPackage::generate(&carol, &carol_provider).unwrap();
        let carol_join = a_group
            .add_member(
                &alice_provider,
                &alice,
                KeyPackage::from_bytes(carol_kp.as_bytes(), &alice_provider).unwrap(),
            )
            .unwrap();
        b_group
            .process_commit(&bob_provider, &carol_join.commit)
            .expect("bob processes carol's add commit");
        let mut c_group =
            Group::join_from_welcome(&carol_provider, &carol, &carol_join.welcome).unwrap();

        // All three at the same epoch now.
        assert_eq!(a_group.epoch(), b_group.epoch());
        assert_eq!(a_group.epoch(), c_group.epoch());
        assert_eq!(a_group.epoch().0, 2);

        // Alice encrypts; both Bob and Carol decrypt.
        let ct = a_group.encrypt(&alice_provider, &alice, b"hello everyone").unwrap();
        let ct_for_bob = ct.clone();
        let ct_for_carol = ct;

        let pt_b = b_group.decrypt(&bob_provider, &ct_for_bob).unwrap();
        let pt_c = c_group.decrypt(&carol_provider, &ct_for_carol).unwrap();
        assert_eq!(&pt_b, b"hello everyone");
        assert_eq!(&pt_c, b"hello everyone");
    }
}
