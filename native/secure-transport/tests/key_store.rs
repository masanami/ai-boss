//! 保管のポートのメモリ実装の受入基準（S1）。

use secrecy::SecretString;
use secure_transport::{KeyStore, MemoryKeyStore, Provider};

#[test]
fn registered_key_is_reported_as_present() {
    let store = MemoryKeyStore::new();
    store
        .set(Provider::Anthropic, SecretString::from("sk-ant-dummy"))
        .unwrap();
    assert!(store.contains(Provider::Anthropic).unwrap());
}

#[test]
fn deleted_key_is_reported_as_absent() {
    let store = MemoryKeyStore::new();
    store
        .set(Provider::Anthropic, SecretString::from("sk-ant-dummy"))
        .unwrap();
    store.delete(Provider::Anthropic).unwrap();
    assert!(!store.contains(Provider::Anthropic).unwrap());
}

#[test]
fn deleting_an_unregistered_key_succeeds() {
    let store = MemoryKeyStore::new();
    assert!(store.delete(Provider::Anthropic).is_ok());
    assert!(!store.contains(Provider::Anthropic).unwrap());
}

// ---- OpenAi（機能仕様 docs/features/llm-provider-abstraction.md 受入基準（S1）「Rust の通信層」）----

#[test]
fn registered_openai_key_is_reported_as_present() {
    let store = MemoryKeyStore::new();
    store
        .set(Provider::OpenAi, SecretString::from("sk-openai-dummy"))
        .unwrap();
    assert!(store.contains(Provider::OpenAi).unwrap());
}

#[test]
fn deleted_openai_key_is_reported_as_absent() {
    let store = MemoryKeyStore::new();
    store
        .set(Provider::OpenAi, SecretString::from("sk-openai-dummy"))
        .unwrap();
    store.delete(Provider::OpenAi).unwrap();
    assert!(!store.contains(Provider::OpenAi).unwrap());
}

/// 保管のポートのメモリ実装で、OpenAI のキーを登録しても、Anthropic の登録の有無は変わらない
/// （受入基準（S1）「Rust の通信層」）。
#[test]
fn registering_openai_key_does_not_affect_anthropic_registration() {
    let store = MemoryKeyStore::new();
    assert!(!store.contains(Provider::Anthropic).unwrap());
    store
        .set(Provider::OpenAi, SecretString::from("sk-openai-dummy"))
        .unwrap();
    assert!(!store.contains(Provider::Anthropic).unwrap());

    store
        .set(Provider::Anthropic, SecretString::from("sk-ant-dummy"))
        .unwrap();
    assert!(store.contains(Provider::Anthropic).unwrap());
    assert!(store.contains(Provider::OpenAi).unwrap());

    store.delete(Provider::OpenAi).unwrap();
    assert!(store.contains(Provider::Anthropic).unwrap());
    assert!(!store.contains(Provider::OpenAi).unwrap());
}
