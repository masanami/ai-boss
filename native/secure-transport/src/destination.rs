//! 宛先の表（名前 → 送信先の URL・付与する資格情報）。
//!
//! 製品版の表は [`DestinationTable::production`] の固定の定数（と、ビルド時に渡す中継の URL）で、呼び出し元は宛先を名前でしか指定できない。

use std::collections::BTreeMap;

use crate::key_store::Provider;

/// Anthropic Messages API の宛先の名前。
pub const ANTHROPIC_MESSAGES: &str = "anthropic-messages";
/// Anthropic Messages API の送信先。
pub const ANTHROPIC_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
/// 付与する `anthropic-version`（現行の `@anthropic-ai/sdk` が送る値）。
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

/// OpenAI Responses API の宛先の名前（機能仕様
/// docs/features/llm-provider-abstraction.md「IF / API（S1）」）。
pub const OPENAI_RESPONSES: &str = "openai-responses";
/// OpenAI Responses API の送信先。
pub const OPENAI_RESPONSES_URL: &str = "https://api.openai.com/v1/responses";

/// ai-boss の LLM 中継サーバーの宛先の名前（機能仕様 docs/features/llm-relay-server.md
/// 「アプリ側の接続（S2）」）。URL はビルド時の環境変数 `AI_BOSS_RELAY_URL` だけから入る。
pub const RELAY_MESSAGES: &str = "relay-messages";

/// 中継の URL として表に入れてよい値か。`https` で、ユーザー名・パスワードを含まず、
/// ホストを持つ URL だけを受け付ける（ライセンストークンを平文・別の資格情報つきの宛先へ
/// 送らない。`http`・空・URL として解釈できない値は拒否）。
pub fn is_valid_relay_url(url: &str) -> bool {
    match reqwest::Url::parse(url) {
        Ok(parsed) => {
            parsed.scheme() == "https"
                && parsed.username().is_empty()
                && parsed.password().is_none()
                && parsed.host_str().is_some_and(|host| !host.is_empty())
        }
        Err(_) => false,
    }
}

/// 送信時に付与する資格情報の種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Credential {
    /// `x-api-key`（保管した Anthropic のキー）と `anthropic-version` を付ける。
    AnthropicApiKey,
    /// `authorization: Bearer <保管した OpenAI のキー>` を付ける。呼び出し元が
    /// 渡した `authorization` は（`x-api-key`/`anthropic-version` と同じく）
    /// この層が既に捨てている。
    OpenAiBearer,
    /// `authorization: Bearer <保管したライセンストークン>` だけを付ける。`x-api-key`・
    /// `anthropic-version` は付けず、呼び出し元の `authorization`・`x-api-key` は捨てる。
    /// 中継の宛先（`relay-messages`）だけがこの資格情報を使う。
    RelayBearer,
}

impl Credential {
    pub(crate) fn provider(self) -> Provider {
        match self {
            Credential::AnthropicApiKey => Provider::Anthropic,
            Credential::OpenAiBearer => Provider::OpenAi,
            Credential::RelayBearer => Provider::RelayLicense,
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

    /// OpenAI Responses API 形式の宛先。
    pub fn openai_responses(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            credential: Credential::OpenAiBearer,
        }
    }

    /// ai-boss の LLM 中継（Anthropic Messages 形式）の宛先。
    pub fn relay_messages(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            credential: Credential::RelayBearer,
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
    /// 製品版の表。ビルド時の環境変数 `AI_BOSS_RELAY_URL` を読むのはここ 1 か所だけで、
    /// 組み立ては [`DestinationTable::production_with`] に渡す（呼び出し元は宛先を名前でしか
    /// 指定できず、実行時に URL を変える手段は無い）。
    pub fn production() -> Self {
        Self::production_with(option_env!("AI_BOSS_RELAY_URL"))
    }

    /// 製品版の表を中継の URL つきで組む。`anthropic-messages`・`openai-responses` の 2 行は固定で、
    /// `relay-messages` の行は `relay_url` が [`is_valid_relay_url`] を満たすときだけ足す
    /// （無い・妥当でないときは行を作らず、送信は `UnknownDestination` で失敗する）。
    pub fn production_with(relay_url: Option<&str>) -> Self {
        let mut entries = vec![
            (
                ANTHROPIC_MESSAGES,
                Destination::anthropic_messages(ANTHROPIC_MESSAGES_URL),
            ),
            (
                OPENAI_RESPONSES,
                Destination::openai_responses(OPENAI_RESPONSES_URL),
            ),
        ];
        if let Some(url) = relay_url.filter(|url| is_valid_relay_url(url)) {
            entries.push((RELAY_MESSAGES, Destination::relay_messages(url)));
        }
        Self::from_entries(entries)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// `production()` の `relay-messages` の行は、ビルド時の `AI_BOSS_RELAY_URL` が妥当なときだけ、
    /// その URL で現れる。**品質ゲートでの担保の限界**: 環境変数を設定しない既定の実行では
    /// 「中継の行が無い」分岐しか通らず、`production()` から `production_with` へ値が渡る結線は
    /// 確かめられない（仕様の仮定 A19 が、環境変数の経路を `production_with` の結合テストで代替する
    /// としている）。
    /// 期待値は実装と同じ式ではなく固定の値で書く。ただしビルド時の環境変数を設定しない既定の
    /// 実行（品質ゲート。仮定 A19）では「中継の行が無い」ことしか確かめられない——値を設定して
    /// ビルドした場合（`AI_BOSS_RELAY_URL=https://relay.example/v1/messages cargo test --lib`）に
    /// `relay-messages` の行がその URL で現れることまで確かめる。環境変数の値の判定そのものは
    /// `production_with` の結合テスト（`tests/transport.rs`）が持つ。
    #[test]
    fn production_has_the_relay_row_only_for_a_valid_build_time_relay_url() {
        let production = DestinationTable::production();
        match option_env!("AI_BOSS_RELAY_URL") {
            Some(url) if is_valid_relay_url(url) => {
                assert_eq!(production.get(RELAY_MESSAGES).map(Destination::url), Some(url));
            }
            _ => assert!(production.get(RELAY_MESSAGES).is_none()),
        }
        assert!(production.get(ANTHROPIC_MESSAGES).is_some() && production.get(OPENAI_RESPONSES).is_some());
    }
}
