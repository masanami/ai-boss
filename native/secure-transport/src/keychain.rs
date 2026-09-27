//! 保管のポートの Apple キーチェーン実装。
//!
//! 項目の属性（クリティカル設計決定 1）:
//! - データ保護キーチェーン（`kSecUseDataProtectionKeychain`。macOS でも iOS と同じ仕組みに揃える）
//! - アクセシビリティは「初回ロック解除後・この端末のみ」（`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`）
//! - 同期しない（`kSecAttrSynchronizable` を偽）

use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use core_foundation_sys::base::{CFGetTypeID, CFTypeRef};
use core_foundation_sys::data::CFDataRef;
use core_foundation_sys::string::CFStringRef;
use secrecy::{ExposeSecret, SecretString};
use security_framework_sys::access_control::kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
use security_framework_sys::base::{errSecDuplicateItem, errSecItemNotFound, errSecSuccess};
use security_framework_sys::item::{
    kSecAttrAccount, kSecAttrService, kSecAttrSynchronizable, kSecClass, kSecClassGenericPassword,
    kSecMatchLimit, kSecReturnData, kSecUseDataProtectionKeychain, kSecValueData,
};
use security_framework_sys::keychain_item::{
    SecItemAdd, SecItemCopyMatching, SecItemDelete, SecItemUpdate,
};
use zeroize::Zeroizing;

use crate::key_store::{KeyStore, Provider, Seal, StoreError};

// security-framework-sys が公開していない定数。
#[link(name = "Security", kind = "framework")]
extern "C" {
    pub(crate) static kSecAttrAccessible: CFStringRef;
    static kSecMatchLimitOne: CFStringRef;
}

/// 製品版のキーチェーンの項目の service 名。
pub const KEYCHAIN_SERVICE: &str = "dev.aiboss.byok";

/// キーチェーンに保管する実装。
pub struct KeychainKeyStore {
    service: String,
}

impl KeychainKeyStore {
    /// 製品版の service 名（[`KEYCHAIN_SERVICE`]）を使う。
    pub fn new() -> Self {
        Self::with_service(KEYCHAIN_SERVICE)
    }

    /// 任意の service 名を使う（実キーチェーンの結合テストが、オーナーの本物の項目に触れないため）。
    pub(crate) fn with_service(service: &str) -> Self {
        Self {
            service: service.to_owned(),
        }
    }

    /// 項目を特定する問い合わせ（class・service・account・データ保護キーチェーン・同期しない）。
    pub(crate) fn item_query(&self, provider: Provider) -> Vec<(CFString, CFType)> {
        vec![
            (
                key(unsafe { kSecClass }),
                cf_string(unsafe { kSecClassGenericPassword }),
            ),
            (
                key(unsafe { kSecAttrService }),
                CFString::new(&self.service).into_CFType(),
            ),
            (
                key(unsafe { kSecAttrAccount }),
                CFString::new(provider.account()).into_CFType(),
            ),
            (
                key(unsafe { kSecUseDataProtectionKeychain }),
                CFBoolean::true_value().into_CFType(),
            ),
            (
                key(unsafe { kSecAttrSynchronizable }),
                CFBoolean::false_value().into_CFType(),
            ),
        ]
    }
}

impl KeychainKeyStore {
    /// 1 件を探す問い合わせ（`contains` と `load`）。`return_data` が真なら値も返させる。
    fn lookup_query(&self, provider: Provider, return_data: bool) -> Vec<(CFString, CFType)> {
        let mut query = self.item_query(provider);
        query.push(match_limit_one());
        if return_data {
            query.push((key(unsafe { kSecReturnData }), CFBoolean::true_value().into_CFType()));
        }
        query
    }
}

impl Default for KeychainKeyStore {
    fn default() -> Self {
        Self::new()
    }
}

impl KeyStore for KeychainKeyStore {
    fn set(&self, provider: Provider, secret: SecretString) -> Result<(), StoreError> {
        let value = CFData::from_buffer(secret.expose_secret().as_bytes()).into_CFType();
        let accessible = cf_string(unsafe { kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly });

        let mut add = self.item_query(provider);
        add.push((key(unsafe { kSecAttrAccessible }), accessible.clone()));
        add.push((key(unsafe { kSecValueData }), value.clone()));
        let add = CFDictionary::from_CFType_pairs(&add);
        let status = unsafe { SecItemAdd(add.as_concrete_TypeRef(), std::ptr::null_mut()) };
        if status != errSecDuplicateItem {
            return check(status);
        }

        let query = CFDictionary::from_CFType_pairs(&self.item_query(provider));
        let update = CFDictionary::from_CFType_pairs(&[
            (key(unsafe { kSecAttrAccessible }), accessible),
            (key(unsafe { kSecValueData }), value),
        ]);
        check(unsafe { SecItemUpdate(query.as_concrete_TypeRef(), update.as_concrete_TypeRef()) })
    }

    fn delete(&self, provider: Provider) -> Result<(), StoreError> {
        let query = CFDictionary::from_CFType_pairs(&self.item_query(provider));
        match unsafe { SecItemDelete(query.as_concrete_TypeRef()) } {
            status if status == errSecItemNotFound => Ok(()),
            status => check(status),
        }
    }

    fn contains(&self, provider: Provider) -> Result<bool, StoreError> {
        let query = CFDictionary::from_CFType_pairs(&self.lookup_query(provider, false));
        match unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), std::ptr::null_mut()) } {
            status if status == errSecItemNotFound => Ok(false),
            status => check(status).map(|()| true),
        }
    }

    fn load(&self, provider: Provider, _seal: Seal) -> Result<Option<SecretString>, StoreError> {
        let query = CFDictionary::from_CFType_pairs(&self.lookup_query(provider, true));

        let mut result: CFTypeRef = std::ptr::null();
        match unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), &mut result) } {
            status if status == errSecItemNotFound => return Ok(None),
            status => check(status)?,
        }
        if result.is_null() || unsafe { CFGetTypeID(result) } != CFData::type_id() {
            return Err(StoreError::Keychain {
                status: security_framework_sys::base::errSecParam,
            });
        }
        let data = unsafe { CFData::wrap_under_create_rule(result as CFDataRef) };
        let bytes = Zeroizing::new(data.bytes().to_vec());
        let text = std::str::from_utf8(&bytes).map_err(|_| StoreError::InvalidEncoding)?;
        Ok(Some(SecretString::from(text)))
    }
}

fn key(constant: CFStringRef) -> CFString {
    unsafe { CFString::wrap_under_get_rule(constant) }
}

fn cf_string(constant: CFStringRef) -> CFType {
    key(constant).into_CFType()
}

/// 一致を 1 件に絞る（`kSecMatchLimit` に `kSecMatchLimitOne` を渡す）。
fn match_limit_one() -> (CFString, CFType) {
    (key(unsafe { kSecMatchLimit }), cf_string(unsafe { kSecMatchLimitOne }))
}

fn check(status: i32) -> Result<(), StoreError> {
    if status == errSecSuccess {
        Ok(())
    } else {
        Err(StoreError::Keychain { status })
    }
}

/// 実キーチェーンの結合テスト（手動実行）。`npm run test:rust:keychain` で実行する（README 参照）。
///
/// テストごとにテスト専用の service 名を使い、オーナーの本物の項目には触れない。作った項目は終了時に削除する。
/// 属性は属性だけの問い合わせで確かめ、値は読み出さない。
#[cfg(test)]
mod tests {
    use core_foundation::base::CFType;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation_sys::dictionary::CFDictionaryRef;
    use security_framework_sys::item::{kSecAttrSynchronizableAny, kSecReturnAttributes};

    use super::*;


    /// テスト専用の項目。落とすと削除する。
    struct TestItem {
        store: KeychainKeyStore,
    }

    impl TestItem {
        fn register(test_name: &str) -> Self {
            let store = KeychainKeyStore::with_service(&format!("dev.aiboss.byok.integration-test.{test_name}"));
            // 前回の実行の残りを消す（失敗の番号は直後の登録で記録する）。
            let _ = store.delete(Provider::Anthropic);
            store
                .set(Provider::Anthropic, SecretString::from("sk-ant-dummy-integration-test"))
                .expect("register a key");
            Self { store }
        }

        /// 項目の属性だけを問い合わせる（値は読み出さない）。
        ///
        /// 検証対象の `item_query` に頼らず、データ保護キーチェーンだけを探す問い合わせをここで組み立てる
        /// （同期の有無は問わない＝属性の値で確かめる）。
        fn attributes(&self) -> CFDictionary<CFString, CFType> {
            let mut query = vec![
                (key(unsafe { kSecClass }), cf_string(unsafe { kSecClassGenericPassword })),
                (key(unsafe { kSecAttrService }), CFString::new(&self.store.service).into_CFType()),
                (key(unsafe { kSecAttrAccount }), CFString::new(Provider::Anthropic.account()).into_CFType()),
                (key(unsafe { kSecUseDataProtectionKeychain }), CFBoolean::true_value().into_CFType()),
                (key(unsafe { kSecAttrSynchronizable }), cf_string(unsafe { kSecAttrSynchronizableAny })),
            ];
            query.push(match_limit_one());
            query.push((key(unsafe { kSecReturnAttributes }), CFBoolean::true_value().into_CFType()));
            let query = CFDictionary::from_CFType_pairs(&query);
            let mut result: CFTypeRef = std::ptr::null();
            check(unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), &mut result) })
                .expect("query attributes");
            assert!(!result.is_null(), "no attributes returned");
            unsafe { CFDictionary::wrap_under_create_rule(result as CFDictionaryRef) }
        }
    }

    impl Drop for TestItem {
        fn drop(&mut self) {
            let _ = self.store.delete(Provider::Anthropic);
        }
    }

    #[test]
    #[ignore = "manual: real keychain (npm run test:rust:keychain)"]
    fn registered_key_is_reported_as_present() {
        let item = TestItem::register("present");
        assert!(item.store.contains(Provider::Anthropic).expect("contains"));
    }

    #[test]
    #[ignore = "manual: real keychain (npm run test:rust:keychain)"]
    fn deleted_key_is_reported_as_absent() {
        let item = TestItem::register("absent");
        item.store.delete(Provider::Anthropic).expect("delete");
        assert!(!item.store.contains(Provider::Anthropic).expect("contains"));
    }

    #[test]
    #[ignore = "manual: real keychain (npm run test:rust:keychain)"]
    fn registered_item_is_in_the_data_protection_keychain() {
        let item = TestItem::register("data-protection");
        // データ保護キーチェーンだけを探す問い合わせ（kSecUseDataProtectionKeychain。`attributes` を参照）で見つかる。
        let attributes = item.attributes();
        // アクセシビリティ（pdmn）はデータ保護キーチェーンの項目にだけある属性。
        assert!(attributes.find(key(unsafe { kSecAttrAccessible })).is_some(), "no accessibility attribute");
    }

    #[test]
    #[ignore = "manual: real keychain (npm run test:rust:keychain)"]
    fn registered_item_is_accessible_after_first_unlock_this_device_only() {
        let item = TestItem::register("accessibility");
        let attributes = item.attributes();
        let accessible = attributes.find(key(unsafe { kSecAttrAccessible })).expect("accessibility attribute");
        let accessible = accessible.downcast::<CFString>().expect("accessibility is a string");
        assert_eq!(accessible, key(unsafe { kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly }));
    }

    #[test]
    #[ignore = "manual: real keychain (npm run test:rust:keychain)"]
    fn registered_item_is_not_synchronizable() {
        let item = TestItem::register("synchronizable");
        let attributes = item.attributes();
        let synchronizable = attributes.find(key(unsafe { kSecAttrSynchronizable })).expect("synchronizable attribute");
        let synchronizable = if let Some(flag) = synchronizable.downcast::<CFBoolean>() {
            bool::from(flag)
        } else {
            let number = synchronizable.downcast::<core_foundation::number::CFNumber>().expect("synchronizable is a boolean or a number");
            number.to_i64() != Some(0)
        };
        assert!(!synchronizable, "kSecAttrSynchronizable must be false");
    }
}

/// 問い合わせ辞書の組み立て（キーチェーンに触れない。既定の `npm run test:rust` で実行する）。
#[cfg(test)]
mod query_tests {
    use super::*;

    fn match_limit(query: &[(CFString, CFType)]) -> Option<CFString> {
        let limit_key = key(unsafe { kSecMatchLimit });
        let (_, value) = query.iter().find(|(name, _)| *name == limit_key)?;
        value.downcast::<CFString>()
    }

    #[test]
    fn lookup_queries_limit_to_one_match_with_the_match_limit_one_constant() {
        let store = KeychainKeyStore::with_service("dev.aiboss.byok.query-test");
        for return_data in [false, true] {
            let query = store.lookup_query(Provider::Anthropic, return_data);
            assert_eq!(
                match_limit(&query),
                Some(key(unsafe { kSecMatchLimitOne })),
                "return_data={return_data}: kSecMatchLimit must be kSecMatchLimitOne"
            );
        }
    }
}
