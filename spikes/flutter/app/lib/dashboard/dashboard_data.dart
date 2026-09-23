import 'dart:async';
import 'package:flutter/foundation.dart';

// web/src/dashboard-response.ts / meeting-schedule.ts の移植＋ダミーデータ（Tauri 側と同じ 4 シナリオを 2.5 秒ごとに巡回）。
class DashboardProgress {
  const DashboardProgress(this.done, this.total, this.ratio);
  final int done;
  final int total;
  final double ratio;
}

class DashboardResponse {
  const DashboardResponse({
    required this.progress,
    required this.morningSessionHeld,
    required this.eveningSessionHeld,
    required this.todayMaxEscalationLevel,
    required this.bossComment,
    required this.date,
  });
  final DashboardProgress progress;
  final bool morningSessionHeld;
  final bool eveningSessionHeld;
  final int todayMaxEscalationLevel;
  final String bossComment;
  final String date;
}

const dummyScenarios = [
  DashboardResponse(progress: DashboardProgress(2, 5, 0.4), morningSessionHeld: false, eveningSessionHeld: false, todayMaxEscalationLevel: 0, bossComment: '今日は資料作成を最優先にしろ。', date: '2026-09-23'),
  DashboardResponse(progress: DashboardProgress(1, 5, 0.2), morningSessionHeld: true, eveningSessionHeld: false, todayMaxEscalationLevel: 0, bossComment: 'まだ 1 件か。次の 30 分で 1 つ片付けろ。', date: '2026-09-23'),
  DashboardResponse(progress: DashboardProgress(4, 5, 0.8), morningSessionHeld: true, eveningSessionHeld: true, todayMaxEscalationLevel: 0, bossComment: 'よくやった。明日もこの調子だ。', date: '2026-09-23'),
  DashboardResponse(progress: DashboardProgress(1, 5, 0.2), morningSessionHeld: true, eveningSessionHeld: true, todayMaxEscalationLevel: 2, bossComment: '催促を 2 回無視したな。理由を報告しろ。', date: '2026-09-23'),
];

class DummyDashboard extends ChangeNotifier {
  DummyDashboard({Duration interval = const Duration(milliseconds: 2500)}) {
    _timer = Timer.periodic(interval, (_) {
      _index = (_index + 1) % dummyScenarios.length;
      notifyListeners();
    });
  }
  late final Timer _timer;
  int _index = 0;
  DashboardResponse get dashboard => dummyScenarios[_index];

  @override
  void dispose() {
    _timer.cancel();
    super.dispose();
  }
}

enum MeetingType { morning, evening }

class MeetingSlot {
  const MeetingSlot({required this.time, required this.defaultTime, required this.overridden, required this.latestAllowedTime});
  final String time;
  final String defaultTime;
  final bool overridden;
  final String latestAllowedTime;
  MeetingSlot withTime(String t) => MeetingSlot(time: t, defaultTime: defaultTime, overridden: t != defaultTime, latestAllowedTime: latestAllowedTime);
}
