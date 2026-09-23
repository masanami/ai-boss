import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'dashboard/dashboard_data.dart';
import 'dashboard/dashboard_view.dart';
import 'dashboard/theme.dart';
import 'spike/keychain_check.dart';
import 'spike/llm_check.dart';
import 'spike/notify_check.dart';
import 'spike/sqlite_check.dart';

void main() {
  runApp(const SpikeApp());
}

class SpikeApp extends StatelessWidget {
  const SpikeApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'ai-boss spike',
      theme: ThemeData(brightness: Brightness.dark, scaffoldBackgroundColor: AppColors.bg, colorSchemeSeed: AppColors.accent),
      home: const HomePage(),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});
  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  final _dummy = DummyDashboard();
  final _results = <String, Map<String, Object?>>{};
  final _keyInput = TextEditingController();
  var _streamText = '';

  late final Map<String, Future<Map<String, Object?>> Function()> _steps = {
    'keychain': runKeychainCheck,
    'sqlite': runSqliteCheck,
    'llm': () => runLlmCheck((t) => setState(() => _streamText = t)),
    'notify': runNotifyBasic,
    'notifyLimit': runNotifyLimit,
  };

  // Tauri 側と同じ: 手動ボタン、または SIMCTL_CHILD_SPIKE_SELFTEST=<カンマ区切り> で自動実行し、
  // 結果を Application Support/<step>.json へ書き出す（simctl get_app_container で回収）
  Future<void> _run(String name) async {
    Map<String, Object?> result;
    try {
      result = await _steps[name]!();
    } catch (e) {
      result = {'ok': false, 'error': e.toString()};
    }
    setState(() => _results[name] = result);
    final dir = await getApplicationSupportDirectory();
    await File('${dir.path}/$name.json').writeAsString(const JsonEncoder.withIndent('  ').convert({'at': DateTime.now().toUtc().toIso8601String(), ...result}));
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final dir = await getApplicationSupportDirectory();
      await File('${dir.path}/boot.json').writeAsString(jsonEncode({'at': DateTime.now().toUtc().toIso8601String()}));
      for (final step in (Platform.environment['SPIKE_SELFTEST'] ?? '').split(',').where((s) => s.isNotEmpty)) {
        if (_steps.containsKey(step)) await _run(step);
      }
    });
  }

  @override
  void dispose() {
    _dummy.dispose();
    _keyInput.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.fromLTRB(16, 24, 16, 32), children: [
          ListenableBuilder(listenable: _dummy, builder: (context, _) => DashboardView(dashboard: _dummy.dashboard)),
          const Divider(height: 32),
          const Text('BYOK（キーチェーン）', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
          Row(children: [
            Expanded(child: TextField(controller: _keyInput, obscureText: true, decoration: const InputDecoration(hintText: 'sk-ant-...'))),
            TextButton(onPressed: () async => {await saveApiKey(_keyInput.text), _keyInput.clear()}, child: const Text('保存')),
          ]),
          Wrap(spacing: 8, children: [for (final name in _steps.keys) OutlinedButton(onPressed: () => _run(name), child: Text(name))]),
          if (_streamText.isNotEmpty) Text(_streamText),
          for (final e in _results.entries)
            Text('${e.key}: ${e.value['ok'] == true ? 'OK' : 'NG'} ${jsonEncode(e.value).substring(0, jsonEncode(e.value).length.clamp(0, 300))}', style: const TextStyle(fontSize: 10, fontFamily: 'Menlo')),
        ]),
      ),
    );
  }
}
