import 'package:flutter/material.dart';
import 'package:latlong2/latlong.dart';

import 'format.dart';
import 'models.dart';
import 'theme.dart';

/// Slides and fades its child in when it first appears.
class FadeSlideIn extends StatelessWidget {
  const FadeSlideIn({super.key, required this.child, this.delay = Duration.zero, this.offset = 16});

  final Widget child;
  final Duration delay;
  final double offset;

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: const Duration(milliseconds: 420) + delay,
      curve: Interval(
        delay.inMilliseconds / (420 + delay.inMilliseconds),
        1,
        curve: Curves.easeOutCubic,
      ),
      builder: (context, v, child) => Opacity(
        opacity: v.clamp(0.0, 1.0),
        child: Transform.translate(offset: Offset(0, (1 - v) * offset), child: child),
      ),
      child: child,
    );
  }
}

/// A soft ring that grows and fades again and again, to show "something is happening".
class Pulse extends StatefulWidget {
  const Pulse({super.key, required this.child, this.color = brandPrimary, this.size = 64});

  final Widget child;
  final Color color;
  final double size;

  @override
  State<Pulse> createState() => _PulseState();
}

class _PulseState extends State<Pulse> with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 1600))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: widget.size,
      height: widget.size,
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, child) {
          return Stack(
            alignment: Alignment.center,
            children: [
              Container(
                width: widget.size * (0.45 + 0.55 * _c.value),
                height: widget.size * (0.45 + 0.55 * _c.value),
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: widget.color.withValues(alpha: 0.28 * (1 - _c.value)),
                ),
              ),
              child!,
            ],
          );
        },
        child: widget.child,
      ),
    );
  }
}

/// A number that counts up or down to its new value.
class AnimatedMoney extends StatelessWidget {
  const AnimatedMoney(this.amount, {super.key, this.style});

  final int amount;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: amount.toDouble()),
      duration: const Duration(milliseconds: 700),
      curve: Curves.easeOutCubic,
      builder: (context, v, _) => Text(ugx(v), style: style),
    );
  }
}

/// A point that glides to each new position instead of jumping, so a captain's
/// marker moves smoothly on the map between location updates.
class SmoothPoint {
  SmoothPoint({required TickerProvider vsync, required this.onChange, Duration duration = const Duration(milliseconds: 1800)})
      : _controller = AnimationController(vsync: vsync, duration: duration) {
    _controller.addListener(_tick);
  }

  final VoidCallback onChange;
  final AnimationController _controller;
  LatLng? _from;
  LatLng? _to;

  /// Where the point is drawn right now.
  LatLng? get value {
    final to = _to;
    final from = _from;
    if (to == null) return null;
    if (from == null) return to;
    final t = Curves.easeInOut.transform(_controller.value);
    return LatLng(
      from.latitude + (to.latitude - from.latitude) * t,
      from.longitude + (to.longitude - from.longitude) * t,
    );
  }

  void moveTo(LatLng? target) {
    if (target == null) {
      _from = null;
      _to = null;
      return;
    }
    final to = _to;
    if (to != null && to.latitude == target.latitude && to.longitude == target.longitude) return;
    _from = value ?? target;
    _to = target;
    _controller
      ..reset()
      ..forward();
  }

  void _tick() => onChange();

  void dispose() {
    _controller.removeListener(_tick);
    _controller.dispose();
  }
}

/// "Captain is 450 m away - about 2 min": a bar that fills as the captain gets closer.
class ArrivalBar extends StatelessWidget {
  const ArrivalBar({
    super.key,
    required this.startKm,
    required this.nowKm,
    required this.title,
    this.color = brandPrimary,
  });

  /// Distance when the captain was first seen heading to the pickup.
  final double startKm;
  final double nowKm;
  final String title;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final progress = startKm <= 0.02 ? 1.0 : (1 - nowKm / startKm).clamp(0.0, 1.0);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        TweenAnimationBuilder<double>(
          tween: Tween(begin: 0, end: progress),
          duration: const Duration(milliseconds: 900),
          curve: Curves.easeOutCubic,
          builder: (context, v, _) => ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: LinearProgressIndicator(value: v, minHeight: 8, color: color, backgroundColor: color.withValues(alpha: 0.15)),
          ),
        ),
      ],
    );
  }
}

/// "340 m" or "1.2 km".
String distanceText(double km) {
  if (km < 1) return '${(km * 100).round() * 10} m';
  return '${km.toStringAsFixed(1)} km';
}

/// A strip that tells people when they have been warned, slowed down or blocked.
class StandingBanner extends StatelessWidget {
  const StandingBanner(this.standing, {super.key});

  final Standing standing;

  @override
  Widget build(BuildContext context) {
    if (standing.isOk || standing.message == null) return const SizedBox.shrink();
    final severe = standing.level == 'paused' || standing.level == 'blocked';
    final color = severe ? const Color(0xFFB3261E) : const Color(0xFFB26A00);
    return FadeSlideIn(
      child: Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: color.withValues(alpha: 0.5)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(severe ? Icons.block : Icons.warning_amber_rounded, color: color),
            const SizedBox(width: 10),
            Expanded(child: Text(standing.message!, style: TextStyle(color: color, fontWeight: FontWeight.w600))),
          ],
        ),
      ),
    );
  }
}

/// "Trip amount" over a big bold figure: all the finished-trip card needs to say.
class AmountSummary extends StatelessWidget {
  const AmountSummary({super.key, required this.label, required this.amount});

  final String label;
  final String amount;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(label, style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 4),
        Text(
          amount,
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 40, fontWeight: FontWeight.w900, color: brandPrimary),
        ),
      ],
    );
  }
}
