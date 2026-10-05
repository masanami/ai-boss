//! 手元の模擬 HTTP サーバー（HTTP/1.1・1 接続 1 要求）。`native/secure-transport/tests/support/mod.rs`
//! の写し（別クレートの tests/ は共有できないため。#581 S3 のコマンドのテストが使う）。
//!
//! 受けた要求を記録し、設定した応答を chunked で返す。`Gate` を付けると最初の断片を送った後、
//! テストの合図（`release`）まで残りの断片を保留し、その間に接続が切れたら `disconnected` で知らせる。

#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

/// 模擬サーバーが受けた要求。
#[derive(Debug, Clone)]
pub struct ReceivedRequest {
    pub method: String,
    pub path: String,
    /// ヘッダ（名前は小文字）。同名のヘッダは出現順にすべて残す。
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl ReceivedRequest {
    pub fn header_values(&self, name: &str) -> Vec<&str> {
        self.headers
            .iter()
            .filter(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
            .collect()
    }
}

/// 最初の断片の後で残りを保留するための合図。
#[derive(Default)]
pub struct Gate {
    release: Notify,
    disconnected: Notify,
    received: Notify,
}

impl Gate {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 保留している残りの断片を送らせる。
    pub fn release(&self) {
        self.release.notify_one();
    }

    /// 要求を受け取ったことを待つ（`hold_head` のとき）。
    pub async fn received(&self) {
        self.received.notified().await;
    }

    /// 保留の間に接続が切れたことを待つ。
    pub async fn disconnected(&self) {
        self.disconnected.notified().await;
    }
}

/// 模擬サーバーが返す応答。
#[derive(Clone)]
pub struct MockResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub chunks: Vec<Vec<u8>>,
    pub gate: Option<Arc<Gate>>,
    /// 真なら、応答の頭を送る前から合図まで保留する（`gate` が必要）。
    pub hold_head: bool,
}

impl MockResponse {
    pub fn new(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            chunks: Vec::new(),
            gate: None,
            hold_head: false,
        }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }

    pub fn chunk(mut self, chunk: &[u8]) -> Self {
        self.chunks.push(chunk.to_vec());
        self
    }

    pub fn gate(mut self, gate: Arc<Gate>) -> Self {
        self.gate = Some(gate);
        self
    }

    pub fn hold_head(mut self) -> Self {
        self.hold_head = true;
        self
    }
}

pub struct MockServer {
    port: u16,
    requests: Arc<Mutex<Vec<ReceivedRequest>>>,
}

impl MockServer {
    /// すべての要求に同じ応答を返すサーバーを起動する。
    pub async fn start(response: MockResponse) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("local addr").port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                let recorded = Arc::clone(&recorded);
                let response = response.clone();
                tokio::spawn(async move { serve(socket, response, recorded).await });
            }
        });
        Self { port, requests }
    }

    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.origin())
    }

    pub fn requests(&self) -> Vec<ReceivedRequest> {
        self.requests.lock().unwrap().clone()
    }
}

async fn serve(
    mut socket: TcpStream,
    response: MockResponse,
    recorded: Arc<Mutex<Vec<ReceivedRequest>>>,
) {
    let Some(request) = read_request(&mut socket).await else {
        return;
    };
    recorded.lock().unwrap().push(request);

    if let (true, Some(gate)) = (response.hold_head, &response.gate) {
        gate.received.notify_one();
        if !wait_for_release(&mut socket, gate).await {
            return;
        }
    }

    let mut head = format!(
        "HTTP/1.1 {} Mock\r\ntransfer-encoding: chunked\r\nconnection: close\r\n",
        response.status
    );
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    if socket.write_all(head.as_bytes()).await.is_err() {
        return;
    }

    for (index, chunk) in response.chunks.iter().enumerate() {
        if index == 1 {
            if let (false, Some(gate)) = (response.hold_head, &response.gate) {
                if !wait_for_release(&mut socket, gate).await {
                    return;
                }
            }
        }
        let frame = [format!("{:x}\r\n", chunk.len()).as_bytes(), chunk, b"\r\n"].concat();
        if socket.write_all(&frame).await.is_err() {
            return;
        }
        let _ = socket.flush().await;
    }
    let _ = socket.write_all(b"0\r\n\r\n").await;
    let _ = socket.flush().await;
}

/// 合図まで待つ。その間に相手が接続を切ったら知らせて偽を返す。
async fn wait_for_release(socket: &mut TcpStream, gate: &Gate) -> bool {
    let mut probe = [0u8; 1];
    tokio::select! {
        () = gate.release.notified() => true,
        _ = socket.read(&mut probe) => {
            gate.disconnected.notify_one();
            false
        }
    }
}

async fn read_request(socket: &mut TcpStream) -> Option<ReceivedRequest> {
    let mut buffer = Vec::new();
    let header_end = loop {
        let mut chunk = [0u8; 4096];
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
    };

    let head = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let method = request_line.next()?.to_owned();
    let path = request_line.next()?.to_owned();
    let headers: Vec<(String, String)> = lines
        .filter(|line| !line.is_empty())
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();

    let length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = buffer[header_end..].to_vec();
    while body.len() < length {
        let mut chunk = [0u8; 4096];
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    Some(ReceivedRequest {
        method,
        path,
        headers,
        body,
    })
}
