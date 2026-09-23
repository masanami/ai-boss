import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'boss_expression.dart';
import 'dashboard_data.dart';
import 'theme.dart';

// web/src/Dashboard.tsx + BossAvatar.tsx + DashboardMeetingSchedule.tsx（+ 各 CSS）の移植。
const _eveningToneTitle = {
  EveningEvaluationTone.praise: 'よくやった',
  EveningEvaluationTone.scold: 'まだ足りない',
  EveningEvaluationTone.neutral: '今日の夕会評価',
};
const _eveningToneMessage = {
  EveningEvaluationTone.praise: '今日のノルマをしっかり達成した。この調子を続けろ。',
  EveningEvaluationTone.scold: '未達が多い。何が邪魔をしたのか、明日は改善しよう。',
  EveningEvaluationTone.neutral: '半分程度は進んだ。明日はもう一段上を狙おう。',
};
const _expressionLabel = {
  BossExpression.normal: '通常',
  BossExpression.satisfied: '満足',
  BossExpression.displeased: '不機嫌',
  BossExpression.encouraging: '激励',
};

class BossAvatar extends StatelessWidget {
  const BossAvatar({super.key, required this.expression});
  final BossExpression expression;

  @override
  Widget build(BuildContext context) {
    // 表情切替アニメーション（Tauri 側の CSS keyframes と同じ「縮小＋回転＋フェードから戻る」）
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 400),
      transitionBuilder: (child, anim) => FadeTransition(
        opacity: Tween(begin: 0.3, end: 1.0).animate(anim),
        child: RotationTransition(
          turns: Tween(begin: -6 / 360, end: 0.0).animate(anim),
          child: ScaleTransition(scale: Tween(begin: 0.8, end: 1.0).animate(anim), child: child),
        ),
      ),
      child: Container(
        key: ValueKey(expression),
        width: 88,
        height: 88,
        decoration: BoxDecoration(
          color: AppColors.bgElevated,
          border: Border.all(color: AppColors.border),
          borderRadius: BorderRadius.circular(12),
        ),
        clipBehavior: Clip.antiAlias,
        child: SvgPicture.asset('assets/boss/boss-${expression.name}.svg', semanticsLabel: _expressionLabel[expression]),
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble(this.text);
  final String text;
  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      painter: _BubbleTailPainter(),
      child: Container(
        margin: const EdgeInsets.only(left: 8),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          color: AppColors.bgElevated,
          border: Border.all(color: AppColors.border),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Text(text, style: const TextStyle(height: 1.6, color: AppColors.text, fontSize: 16)),
      ),
    );
  }
}

class _BubbleTailPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final y = size.height / 2;
    final path = Path()
      ..moveTo(0, y)
      ..lineTo(8, y - 8)
      ..lineTo(8, y + 8)
      ..close();
    canvas.drawPath(path, Paint()..color = AppColors.border);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text, {this.color = AppColors.textMuted});
  final String text;
  final Color color;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(text.toUpperCase(), style: TextStyle(fontSize: 13.6, letterSpacing: 0.6, color: color, fontWeight: FontWeight.bold)),
      );
}

class ProgressGauge extends StatelessWidget {
  const ProgressGauge({super.key, required this.progress});
  final DashboardProgress progress;

  @override
  Widget build(BuildContext context) {
    final percentage = (progress.ratio * 100).round();
    final level = resolveProgressLevel(progress.ratio);
    final color = switch (level) {
      ProgressLevel.low => AppColors.textMuted,
      ProgressLevel.mid => AppColors.accent.withValues(alpha: 0.7),
      ProgressLevel.high => AppColors.accentWarm,
    };
    return Semantics(
      label: '今日の進捗',
      value: '$percentage%',
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const _SectionTitle('今日のノルマ達成状況'),
        Container(
          height: 14,
          decoration: BoxDecoration(
            color: AppColors.bgElevated,
            border: Border.all(color: AppColors.border),
            borderRadius: BorderRadius.circular(999),
          ),
          clipBehavior: Clip.antiAlias,
          child: LayoutBuilder(
            builder: (context, c) => Align(
              alignment: Alignment.centerLeft,
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 300),
                curve: Curves.ease,
                width: c.maxWidth * progress.ratio,
                decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(999)),
              ),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text('${progress.done} / ${progress.total} 件完了（$percentage%）', style: const TextStyle(fontSize: 14.4, color: AppColors.textMuted)),
      ]),
    );
  }
}

class MeetingScheduleSection extends StatefulWidget {
  const MeetingScheduleSection({super.key});
  @override
  State<MeetingScheduleSection> createState() => _MeetingScheduleSectionState();
}

class _MeetingScheduleSectionState extends State<MeetingScheduleSection> {
  // スパイク: /api/meeting-schedule をメモリ上のダミーに差し替える
  final Map<MeetingType, MeetingSlot> _schedule = {
    MeetingType.morning: const MeetingSlot(time: '09:00', defaultTime: '09:00', overridden: false, latestAllowedTime: '23:59'),
    MeetingType.evening: const MeetingSlot(time: '18:00', defaultTime: '18:00', overridden: false, latestAllowedTime: '23:59'),
  };
  late final Map<MeetingType, String> _form = {for (final e in _schedule.entries) e.key: e.value.time};
  static const _labels = {MeetingType.morning: '朝会', MeetingType.evening: '夕会'};

  Future<void> _pick(MeetingType type) async {
    final parts = _form[type]!.split(':');
    final picked = await showTimePicker(context: context, initialTime: TimeOfDay(hour: int.parse(parts[0]), minute: int.parse(parts[1])));
    if (picked != null) {
      setState(() => _form[type] = '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
      decoration: BoxDecoration(
        color: AppColors.bgElevated,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const _SectionTitle('今日の会'),
        for (final type in MeetingType.values)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Text(
              '${_labels[type]} ${_schedule[type]!.time}${_schedule[type]!.overridden ? '（既定 ${_schedule[type]!.defaultTime} から変更）' : ''}',
              style: const TextStyle(color: AppColors.text, fontSize: 16),
            ),
          ),
        const SizedBox(height: 8),
        Wrap(spacing: 12, children: [
          for (final type in MeetingType.values)
            Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(_labels[type]!, style: const TextStyle(color: AppColors.textMuted)),
              OutlinedButton(onPressed: () => _pick(type), child: Text(_form[type]!)),
            ]),
        ]),
        Wrap(spacing: 8, children: [
          FilledButton.tonal(
            onPressed: () => setState(() {
              for (final type in MeetingType.values) {
                _schedule[type] = _schedule[type]!.withTime(_form[type]!);
              }
            }),
            child: const Text('保存'),
          ),
          for (final type in MeetingType.values)
            if (_schedule[type]!.overridden)
              TextButton(
                onPressed: () => setState(() {
                  _schedule[type] = _schedule[type]!.withTime(_schedule[type]!.defaultTime);
                  _form[type] = _schedule[type]!.time;
                }),
                child: Text('${_labels[type]}を既定に戻す'),
              ),
        ]),
      ]),
    );
  }
}

class DashboardView extends StatelessWidget {
  const DashboardView({super.key, required this.dashboard});
  final DashboardResponse dashboard;

  @override
  Widget build(BuildContext context) {
    final expression = resolveBossExpression(BossExpressionContext(
      progressRatio: dashboard.progress.ratio,
      morningSessionHeld: dashboard.morningSessionHeld,
      eveningSessionHeld: dashboard.eveningSessionHeld,
      todayMaxEscalationLevel: dashboard.todayMaxEscalationLevel,
    ));
    final tone = resolveEveningEvaluationTone(dashboard.progress.ratio);
    final (bg, border, titleColor) = switch (tone) {
      EveningEvaluationTone.praise => (AppColors.praiseBg, AppColors.accentWarm, AppColors.accentWarm),
      EveningEvaluationTone.scold => (AppColors.scoldBg, AppColors.scold, AppColors.scold),
      EveningEvaluationTone.neutral => (AppColors.bgElevated, AppColors.border, AppColors.textMuted),
    };

    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Semantics(
        label: 'ボスから今日のひとこと',
        child: Row(children: [
          BossAvatar(expression: expression),
          const SizedBox(width: 16),
          Expanded(child: _Bubble(dashboard.bossComment)),
        ]),
      ),
      const SizedBox(height: 24),
      ProgressGauge(progress: dashboard.progress),
      const SizedBox(height: 24),
      const MeetingScheduleSection(),
      if (dashboard.eveningSessionHeld) ...[
        const SizedBox(height: 24),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
          decoration: BoxDecoration(color: bg, border: Border.all(color: border), borderRadius: BorderRadius.circular(10)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            _SectionTitle(_eveningToneTitle[tone]!, color: titleColor),
            Text(_eveningToneMessage[tone]!, style: const TextStyle(height: 1.6, color: AppColors.text)),
          ]),
        ),
      ],
    ]);
  }
}
