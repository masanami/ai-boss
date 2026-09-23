import 'dart:convert';
import 'package:http/http.dart' as http;
import 'keychain_check.dart';

// 項目 3: Anthropic Messages API をストリーミングで直接叩く（公式 Dart SDK は無いため HTTP 直叩き＋SSE 手書きパース）。
const _createTaskTool = {
  'name': 'create_task',
  'description': "新しいタスクを作成する。カテゴリは 'work' 固定で自動設定される。",
  'input_schema': {
    'type': 'object',
    'properties': {
      'title': {'type': 'string', 'description': 'タスクのタイトル（必須）'},
      'due_at': {'type': 'string', 'description': '締切（ローカル暦日 "YYYY-MM-DD"）'},
      'boss_comment': {'type': 'string', 'description': 'ボスの決定・コメント'},
    },
    'required': ['title'],
  },
};

Future<Map<String, Object?>> runLlmCheck(void Function(String text) onDelta) async {
  final key = await readApiKey();
  if (key == null) return {'ok': false, 'error': 'no api key in keychain'};
  final sw = Stopwatch()..start();
  final request = http.Request('POST', Uri.parse('https://api.anthropic.com/v1/messages'))
    ..headers.addAll({'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01'})
    ..body = jsonEncode({
      'model': 'claude-haiku-4-5-20251001',
      'max_tokens': 256,
      'stream': true,
      'system': 'あなたは部下を管理する上司。まず日本語で一言だけ決定を述べ、その後に必ず create_task ツールを 1 回呼ぶこと。',
      'tools': [_createTaskTool],
      'messages': [
        {'role': 'user', 'content': '明日までに週報を書かないといけません。'},
      ],
    });
  final client = http.Client();
  try {
    final res = await client.send(request);
    if (res.statusCode != 200) return {'ok': false, 'status': res.statusCode, 'error': await res.stream.bytesToString()};
    var text = '';
    var toolName = '';
    var stopReason = '';
    final toolJson = StringBuffer();
    final chunkTimes = <int>[];
    var firstTextMs = -1;
    await for (final line in res.stream.transform(utf8.decoder).transform(const LineSplitter())) {
      chunkTimes.add(sw.elapsedMilliseconds);
      if (!line.startsWith('data: ')) continue;
      final ev = jsonDecode(line.substring(6)) as Map<String, dynamic>;
      switch (ev['type']) {
        case 'content_block_start' when ev['content_block']['type'] == 'tool_use':
          toolName = ev['content_block']['name'] as String;
        case 'content_block_delta' when ev['delta']['type'] == 'text_delta':
          if (firstTextMs < 0) firstTextMs = sw.elapsedMilliseconds;
          text += ev['delta']['text'] as String;
          onDelta(text);
        case 'content_block_delta' when ev['delta']['type'] == 'input_json_delta':
          toolJson.write(ev['delta']['partial_json']);
        case 'message_delta':
          stopReason = ev['delta']['stop_reason'] as String? ?? '';
      }
    }
    return {
      'ok': toolName == 'create_task' && text.isNotEmpty,
      'text': text,
      'toolName': toolName,
      'toolInput': toolJson.isEmpty ? null : jsonDecode(toolJson.toString()),
      'stopReason': stopReason,
      'firstTextMs': firstTextMs,
      'totalMs': sw.elapsedMilliseconds,
    };
  } finally {
    client.close();
  }
}
