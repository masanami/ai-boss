//! 中継の URL（ビルド時の環境変数 `AI_BOSS_RELAY_URL`。`DestinationTable::production` が
//! `option_env!` で読む）が変わったら、再コンパイルされるようにする。

fn main() {
    println!("cargo:rerun-if-env-changed=AI_BOSS_RELAY_URL");
    println!("cargo:rerun-if-changed=build.rs");
}
