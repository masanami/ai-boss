//! 宛先の表（名前 → 送信先の URL・付与する資格情報）。
//!
//! 製品版の表は [`DestinationTable::production`] の固定の定数で、呼び出し元は宛先を名前でしか指定できない。

use std::collections::BTreeMap;

use crate::key_store::Provider;

/// Anthropic Messages API の宛先の名前。
pub const ANTHROPIC_MESSAGES: &str = "anthropic-messages";
/// Anthropic Messages API の送信先。
pub const ANTHROPIC_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
/// 付与する `anthropic-version`（現行の `@anthropic-ai/sdk` が送る値）。
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

/// 送信時に付与する資格情報の種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Credential {
    /// `x-api-key`（保管した Anthropic のキー）と `anthropic-version` を付ける。
    AnthropicApiKey,
}

impl Credential {
    pub(crate) fn provider(self) -> Provider {
        match self {
            Credential::AnthropicApiKey => Provider::Anthropic,
        }
    }
}

/// 1 つの宛先。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Destination {
    url: String,
    credential: Credential,
}

impl Destination {
    /// Anthropic Messages API 形式の宛先。
    pub fn anthropic_messages(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            credential: Credential::AnthropicApiKey,
        }
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn credential(&self) -> Credential {
        self.credential
    }
}

/// 宛先の表。送信の部品を組み立てるときに渡す。
#[derive(Debug, Clone)]
pub struct DestinationTable {
    entries: BTreeMap<String, Destination>,
}

impl DestinationTable {
    /// 製品版の表（`anthropic-messages` → `https://api.anthropic.com/v1/messages` の 1 行だけ）。
    pub fn production() -> Self {
        Self::from_entries([(
            ANTHROPIC_MESSAGES,
            Destination::anthropic_messages(ANTHROPIC_MESSAGES_URL),
        )])
    }

    /// 任意の表（テストが模擬サーバーの URL を渡すため）。
    pub fn from_entries<N: Into<String>>(
        entries: impl IntoIterator<Item = (N, Destination)>,
    ) -> Self {
        Self {
            entries: entries
                .into_iter()
                .map(|(name, destination)| (name.into(), destination))
                .collect(),
        }
    }

    pub fn get(&self, name: &str) -> Option<&Destination> {
        self.entries.get(name)
    }

    /// 表の宛先の名前（昇順）。
    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.entries.keys().map(String::as_str)
    }
}
