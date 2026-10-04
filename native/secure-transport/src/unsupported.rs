//! 保管できない端末の保管（#674 S1・docs/features/android-shell.md 決定 7・A2）。
//!
//! Android Keystore による保管は S2 で作る。それまでの Android の器はこの保管を使い、
//! すべての操作を [`StoreError::Unsupported`] で失敗させる（成功を装わない）。
//! `contains` も偽（未登録）を返さず失敗を返すため、画面は「未登録」と「保管できない」を
//! 区別できる。`load` も `Ok(None)` を返さないため、送信は「キー未登録」ではなく保管の
//! 失敗で止まり、送信先へ接続しない。
//!
//! どのターゲットでもコンパイルする（ホストの単体テストで振る舞いを確かめるため）。
//! 器がこの保管を選ぶのは `cfg(target_os = "android")` のときだけである。

use secrecy::SecretString;

use crate::key_store::{KeyStore, Provider, Seal, StoreError};

/// すべての操作を「この端末では保管できない」で失敗させる保管。
#[derive(Debug, Default, Clone, Copy)]
pub struct UnsupportedKeyStore;

impl UnsupportedKeyStore {
    pub fn new() -> Self {
        Self
    }
}

impl KeyStore for UnsupportedKeyStore {
    fn set(&self, _provider: Provider, _key: SecretString) -> Result<(), StoreError> {
        Err(StoreError::Unsupported)
    }

    fn delete(&self, _provider: Provider) -> Result<(), StoreError> {
        Err(StoreError::Unsupported)
    }

    fn contains(&self, _provider: Provider) -> Result<bool, StoreError> {
        Err(StoreError::Unsupported)
    }

    fn load(&self, _provider: Provider, _seal: Seal) -> Result<Option<SecretString>, StoreError> {
        Err(StoreError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROVIDERS: [Provider; 3] = [Provider::Anthropic, Provider::OpenAi, Provider::RelayLicense];

    #[test]
    fn set_fails_as_unsupported_for_every_provider() {
        for provider in PROVIDERS {
            assert_eq!(
                UnsupportedKeyStore::new().set(provider, SecretString::from("sk-dummy")),
                Err(StoreError::Unsupported),
                "{provider:?}"
            );
        }
    }

    #[test]
    fn delete_fails_as_unsupported_for_every_provider() {
        for provider in PROVIDERS {
            assert_eq!(UnsupportedKeyStore::new().delete(provider), Err(StoreError::Unsupported), "{provider:?}");
        }
    }

    #[test]
    fn contains_fails_as_unsupported_instead_of_reporting_not_registered() {
        for provider in PROVIDERS {
            assert_eq!(UnsupportedKeyStore::new().contains(provider), Err(StoreError::Unsupported), "{provider:?}");
        }
    }

    #[test]
    fn load_fails_as_unsupported_instead_of_returning_none() {
        for provider in PROVIDERS {
            let result = UnsupportedKeyStore::new().load(provider, Seal::new());
            assert!(matches!(result, Err(StoreError::Unsupported)), "{provider:?}");
        }
    }

    #[test]
    fn unsupported_is_displayed_without_a_key() {
        assert_eq!(StoreError::Unsupported.to_string(), "secure storage is not available on this device");
    }
}
