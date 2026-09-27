//! 保管のポートのメモリ実装の受入基準（S1）。

use secrecy::SecretString;
use secure_transport::{KeyStore, MemoryKeyStore, Provider};

#[test]
fn registered_key_is_reported_as_present() {
    let store = MemoryKeyStore::new();
    store.set(Provider::Anthropic, SecretString::from("sk-ant-dummy")).unwrap();
    assert!(store.contains(Provider::Anthropic).unwrap());
}

#[test]
fn deleted_key_is_reported_as_absent() {
    let store = MemoryKeyStore::new();
    store.set(Provider::Anthropic, SecretString::from("sk-ant-dummy")).unwrap();
    store.delete(Provider::Anthropic).unwrap();
    assert!(!store.contains(Provider::Anthropic).unwrap());
}

#[test]
fn deleting_an_unregistered_key_succeeds() {
    let store = MemoryKeyStore::new();
    assert!(store.delete(Provider::Anthropic).is_ok());
    assert!(!store.contains(Provider::Anthropic).unwrap());
}
