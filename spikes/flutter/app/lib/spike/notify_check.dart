import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_timezone/flutter_timezone.dart';
import 'package:timezone/data/latest.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;

// 項目 4: flutter_local_notifications の zonedSchedule で予約・取り消し・再予約・上限 64 件。
final _plugin = FlutterLocalNotificationsPlugin();
var _initialized = false;

Future<bool> _init() async {
  if (!_initialized) {
    tzdata.initializeTimeZones();
    final tzInfo = await FlutterTimezone.getLocalTimezone();
    tz.setLocalLocation(tz.getLocation(tzInfo.identifier));
    await _plugin.initialize(settings: const InitializationSettings(iOS: DarwinInitializationSettings()));
    _initialized = true;
  }
  final ios = _plugin.resolvePlatformSpecificImplementation<IOSFlutterLocalNotificationsPlugin>()!;
  return await ios.requestPermissions(alert: true, badge: true, sound: true) ?? false;
}

Future<void> _schedule(int id, String body, int secondsFromNow) => _plugin.zonedSchedule(
      id: id,
      title: 'ai-boss spike',
      body: body,
      scheduledDate: tz.TZDateTime.now(tz.local).add(Duration(seconds: secondsFromNow)),
      notificationDetails: const NotificationDetails(iOS: DarwinNotificationDetails()),
      androidScheduleMode: AndroidScheduleMode.inexactAllowWhileIdle,
    );

Future<Map<String, Object?>> runNotifyBasic() async {
  final granted = await _init();
  if (!granted) return {'ok': false, 'granted': false};
  await _schedule(101, '取り消される予約（届いたら NG）', 40);
  await _schedule(102, '再予約前（届いたら NG）', 45);
  final afterSchedule = (await _plugin.pendingNotificationRequests()).map((p) => p.id).toList();
  await _plugin.cancel(id: 101);
  await _schedule(102, '再予約後の通知（アプリ終了中に届けば OK）', 60);
  final afterReschedule = await _plugin.pendingNotificationRequests();
  return {
    'ok': afterReschedule.length == 1,
    'granted': granted,
    'afterSchedule': afterSchedule,
    'afterReschedule': afterReschedule.map((p) => {'id': p.id, 'body': p.body}).toList(),
  };
}

Future<Map<String, Object?>> runNotifyLimit() async {
  final granted = await _init();
  if (!granted) return {'ok': false, 'granted': false};
  await _plugin.cancelAll();
  for (var i = 0; i < 70; i++) {
    await _schedule(1000 + i, 'limit probe #$i', 3600 + i * 60);
  }
  final ids = (await _plugin.pendingNotificationRequests()).map((p) => p.id).toList()..sort();
  await _plugin.cancelAll();
  return {'ok': true, 'requested': 70, 'pendingCount': ids.length, 'firstId': ids.firstOrNull, 'lastId': ids.lastOrNull};
}
