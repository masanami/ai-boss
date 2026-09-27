//! 保管のポート（キーの登録・削除・登録の有無）と、テスト用のメモリ実装。
//!
//! キーの値を読み出す [`KeyStore::load`] は封印（[`Seal`]）を引数に取り、封印はこの
//! クレートの外で作れない。したがってライブラリの外からキーの値は読み出せない。
//!
//! ```compile_fail
//! use secrecy::SecretString;
//! use secure_transport::{KeyStore, MemoryKeyStore, Provider};
//!
//! let store = MemoryKeyStore::new();
//! store.set(Provider::Anthropic, SecretString::from("sk-dummy")).unwrap();
//! // 封印を作る手段がクレートの外に無いため、コンパイルできない。
//! let _ = store.load(Provider::Anthropic, secure_transport::Seal::new());
//! ```
//!
//! 封印を名指ししなくても（型推論や引数の省略で）呼べない:
//!
//! ```compile_fail
//! use secrecy::SecretString;
//! use secure_transport::{KeyStore, MemoryKeyStore, Provider};
//!
//! let store = MemoryKeyStore::new();
//! store.set(Provider::Anthropic, SecretString::from("sk-dummy")).unwrap();
//! // 封印を外して `load(provider)` にすると、この行がコンパイルできてしまう。
//! let _ = store.load(Provider::Anthropic);
//! ```
//!
//! ```compile_fail
//! use secrecy::SecretString;
//! use secure_transport::{KeyStore, MemoryKeyStore, Provider};
//!
//! let store = MemoryKeyStore::new();
//! store.set(Provider::Anthropic, SecretString::from("sk-dummy")).unwrap();
//! // 封印に `Default` 等の外から作れる手段を足すと、この行がコンパイルできてしまう。
//! let _ = store.load(Provider::Anthropic, Default::default());
//! ```
//!
//! 上の `compile_fail` が「読み出し以外の理由」で失敗していないことは、読み出しを除いた
//! 同じコードがコンパイルできることで確かめる（safe なコードの範囲の保証。実際の境界は、
//! 値を返すコマンドを作らない Tauri のコマンドの層にある）:
//!
//! ```
//! use secrecy::SecretString;
//! use secure_transport::{KeyStore, MemoryKeyStore, Provider};
//!
//! let store = MemoryKeyStore::new();
//! store.set(Provider::Anthropic, SecretString::from("sk-dummy")).unwrap();
//! assert!(store.contains(Provider::Anthropic).unwrap());
//! ```

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

use secrecy::SecretString;

/// キーを保管するプロバイダ。キーの項目はプロバイダごとに 1 件。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Provider {
    Anthropic,
    OpenAi,
}

impl Provider {
    /// キーチェーンの項目の account 名。
    pub fn account(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::OpenAi => "openai",
        }
    }
}

/// 保管の失敗。キーの値は持たない。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// キーチェーンの操作が失敗した（OSStatus の番号）。
    Keychain { status: i32 },
    /// 保管されている値が UTF-8 の文字列ではない。
    InvalidEncoding,
    /// 保管されている値が HTTP のヘッダ値として使えない（改行・制御文字など）。
    InvalidKeyFormat,
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Keychain { status } => {
                write!(f, "keychain operation failed (OSStatus {status})")
            }
            StoreError::InvalidEncoding => write!(f, "stored key is not valid UTF-8"),
            StoreError::InvalidKeyFormat => write!(f, "stored key is not a valid header value"),
        }
    }
}

impl std::error::Error for StoreError {}

mod sealed {
    /// キーの値の読み出しを、このクレートの中だけに閉じる封印。
    /// 型はクレートの外から名指しできず、値も作れない。
    pub struct Seal(());

    impl Seal {
        pub(crate) fn new() -> Self {
            Seal(())
        }
    }
}

pub(crate) use sealed::Seal;

/// 保管のポート。実装はこのクレートの中に置く（封印により外から実装も呼び出しもできない）。
pub trait KeyStore: Send + Sync {
    /// キーを登録する（既にあれば差し替える）。
    fn set(&self, provider: Provider, key: SecretString) -> Result<(), StoreError>;
    /// キーを削除する。未登録でも失敗しない。
    fn delete(&self, provider: Provider) -> Result<(), StoreError>;
    /// キーが登録されているか。
    fn contains(&self, provider: Provider) -> Result<bool, StoreError>;
    /// キーの値を読み出す。送信時に資格情報を付与するためだけに、クレートの中から呼ぶ。
    #[doc(hidden)]
    fn load(&self, provider: Provider, seal: Seal) -> Result<Option<SecretString>, StoreError>;
}

/// メモリ上の保管（テスト用）。
#[derive(Default)]
pub struct MemoryKeyStore {
    keys: Mutex<HashMap<Provider, SecretString>>,
}

impl MemoryKeyStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn keys(&self) -> std::sync::MutexGuard<'_, HashMap<Provider, SecretString>> {
        self.keys
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl KeyStore for MemoryKeyStore {
    fn set(&self, provider: Provider, key: SecretString) -> Result<(), StoreError> {
        self.keys().insert(provider, key);
        Ok(())
    }

    fn delete(&self, provider: Provider) -> Result<(), StoreError> {
        self.keys().remove(&provider);
        Ok(())
    }

    fn contains(&self, provider: Provider) -> Result<bool, StoreError> {
        Ok(self.keys().contains_key(&provider))
    }

    fn load(&self, provider: Provider, _seal: Seal) -> Result<Option<SecretString>, StoreError> {
        Ok(self.keys().get(&provider).cloned())
    }
}
