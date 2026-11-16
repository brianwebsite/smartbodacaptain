import 'package:flutter/material.dart';

import 'theme.dart';

/// A slider the person drags all the way across to confirm, so a trip is never started or
/// finished by an accidental tap.
class SlideToConfirm extends StatefulWidget {
  const SlideToConfirm({
    super.key,
    required this.label,
    required this.onConfirmed,
    this.color = brandPrimary,
    this.enabled = true,
  });

  final String label;
  final Future<void> Function() onConfirmed;
  final Color color;
  final bool enabled;

  @override
  State<SlideToConfirm> createState() => _SlideToConfirmState();
}

class _SlideToConfirmState extends State<SlideToConfirm> with SingleTickerProviderStateMixin {
  static const _thumb = 52.0;
  double _x = 0; // how far the thumb has moved, in pixels
  bool _done = false;
  late final AnimationController _back = AnimationController(vsync: this, duration: const Duration(milliseconds: 220))
    ..addListener(() => setState(() => _x = _from * (1 - _back.value)));
  double _from = 0;

  @override
  void dispose() {
    _back.dispose();
    super.dispose();
  }

  Future<void> _release(double max) async {
    if (_x >= max * 0.85) {
      setState(() {
        _x = max;
        _done = true;
      });
      try {
        await widget.onConfirmed();
      } finally {
        if (mounted) {
          setState(() => _done = false);
          _springBack(max);
        }
      }
    } else {
      _springBack(_x);
    }
  }

  void _springBack(double from) {
    _from = from;
    _back.forward(from: 0);
  }

  @override
  Widget build(BuildContext context) {
    final on = widget.enabled && !_done;
    return LayoutBuilder(builder: (context, box) {
      final max = box.maxWidth - _thumb - 8;
      final progress = max <= 0 ? 0.0 : (_x / max).clamp(0.0, 1.0);
      return Opacity(
        opacity: widget.enabled ? 1 : 0.5,
        child: Container(
          height: _thumb + 8,
          decoration: BoxDecoration(
            color: widget.color.withValues(alpha: 0.14),
            borderRadius: BorderRadius.circular(40),
            border: Border.all(color: widget.color, width: 1.5),
          ),
          child: Stack(
            alignment: Alignment.centerLeft,
            children: [
              // The coloured trail behind the thumb.
              Container(
                width: _thumb + 8 + _x,
                decoration: BoxDecoration(color: widget.color.withValues(alpha: 0.25), borderRadius: BorderRadius.circular(40)),
              ),
              Center(
                child: Opacity(
                  opacity: 1 - progress,
                  child: Padding(
                    padding: const EdgeInsets.only(left: _thumb),
                    child: Text(
                      _done ? 'Please wait...' : '${widget.label}  >>',
                      style: TextStyle(color: widget.color, fontWeight: FontWeight.w800, fontSize: 17),
                    ),
                  ),
                ),
              ),
              Positioned(
                left: 4 + _x,
                child: GestureDetector(
                  onHorizontalDragUpdate: on ? (d) => setState(() => _x = (_x + d.delta.dx).clamp(0.0, max)) : null,
                  onHorizontalDragEnd: on ? (_) => _release(max) : null,
                  child: Container(
                    width: _thumb,
                    height: _thumb,
                    decoration: BoxDecoration(color: widget.color, shape: BoxShape.circle),
                    child: _done
                        ? const Padding(
                            padding: EdgeInsets.all(14),
                            child: CircularProgressIndicator(strokeWidth: 3, color: Colors.white),
                          )
                        : const Icon(Icons.chevron_right, color: Colors.white, size: 34),
                  ),
                ),
              ),
            ],
          ),
        ),
      );
    });
  }
}
