//! 秘密情報を扱う通信層（Tauri に依存しない）。
//!
//! - [`KeyStore`] — BYOK の API キーの保管のポート（Apple のキーチェーン実装 [`KeychainKeyStore`] と
//!   テスト用の [`MemoryKeyStore`]）。キーの値を読み出す手段はクレートの外に無い
//! - [`DestinationTable`] — 宛先の名前 → 送信先・付与する資格情報の表
//! - [`SecureTransport`] — 資格情報を付与するストリーミング転送（中止つき・リダイレクトに追従しない）

mod destination;
mod key_store;
#[cfg(target_vendor = "apple")]
mod keychain;
mod transport;

pub use destination::{
    Credential, Destination, DestinationTable, ANTHROPIC_MESSAGES, ANTHROPIC_MESSAGES_URL, ANTHROPIC_VERSION,
    OPENAI_RESPONSES, OPENAI_RESPONSES_URL,
};
pub use key_store::{KeyStore, MemoryKeyStore, Provider, StoreError};
#[cfg(target_vendor = "apple")]
pub use keychain::{KeychainKeyStore, KEYCHAIN_SERVICE};
pub use transport::{ResponseHead, ResponseStream, SecureTransport, SendRequest, TransportError};
