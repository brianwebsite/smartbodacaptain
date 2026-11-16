import 'dart:async';

import 'package:flutter/material.dart';

import 'theme.dart';

/// Shows the welcome animation first, then slides the app in once it is ready.
/// The animation always plays for a moment, even if the app is ready sooner.
class Entrance extends StatefulWidget {
  const Entrance({super.key, required this.ready, required this.child});

  /// False while the app is still checking the saved sign-in.
  final bool ready;
  final Widget child;

  @override
  State<Entrance> createState() => _EntranceState();
}

class _EntranceState extends State<Entrance> {
  bool _minimumShown = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer(const Duration(milliseconds: 2600), () {
      if (mounted) setState(() => _minimumShown = true);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final showApp = _minimumShown && widget.ready;
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 600),
      switchInCurve: Curves.easeOutCubic,
      switchOutCurve: Curves.easeInCubic,
      transitionBuilder: (child, animation) {
        // The app slides in from the right while the welcome screen fades away to the left.
        final entering = child.key == const ValueKey('app');
        final offset = Tween<Offset>(
          begin: entering ? const Offset(1, 0) : const Offset(-0.3, 0),
          end: Offset.zero,
        ).animate(animation);
        return SlideTransition(position: offset, child: FadeTransition(opacity: animation, child: child));
      },
      child: showApp
          ? KeyedSubtree(key: const ValueKey('app'), child: widget.child)
          : const WelcomeSplash(key: ValueKey('splash')),
    );
  }
}

/// "Welcome to Smart Boda · Smart Cars · Smart Rides", each line sliding in one after the other.
class WelcomeSplash extends StatefulWidget {
  const WelcomeSplash({super.key});

  @override
  State<WelcomeSplash> createState() => _WelcomeSplashState();
}

class _WelcomeSplashState extends State<WelcomeSplash> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 2400))..forward();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  Animation<double> _step(double from, double to) =>
      CurvedAnimation(parent: _c, curve: Interval(from, to, curve: Curves.easeOutCubic));

  Widget _line(String text, Animation<double> a, double dx, TextStyle style) {
    return AnimatedBuilder(
      animation: a,
      builder: (_, __) => Opacity(
        opacity: a.value.clamp(0.0, 1.0),
        child: Transform.translate(offset: Offset(dx * (1 - a.value), 0), child: Text(text, style: style)),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final logo = CurvedAnimation(parent: _c, curve: const Interval(0, 0.35, curve: Curves.elasticOut));
    return Scaffold(
      body: Container(
        width: double.infinity,
        decoration: const BoxDecoration(
          gradient: LinearGradient(colors: [brandPrimary, brandDark], begin: Alignment.topLeft, end: Alignment.bottomRight),
        ),
        child: CustomPaint(
          painter: _GoldStripes(CurvedAnimation(parent: _c, curve: const Interval(0, 0.6, curve: Curves.easeOutCubic))),
          child: SafeArea(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              AnimatedBuilder(
                animation: logo,
                builder: (_, child) => Transform.scale(scale: 0.3 + 0.7 * logo.value, child: child),
                child: Container(
                  height: 110,
                  width: 110,
                  decoration: const BoxDecoration(shape: BoxShape.circle, color: Colors.white),
                  child: const Icon(Icons.two_wheeler, size: 64, color: brandPrimary),
                ),
              ),
              const SizedBox(height: 28),
              _line('Welcome to', _step(0.2, 0.5), -60, const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w800)),
              _line('Smart Boda', _step(0.3, 0.6), 80,
                  const TextStyle(color: Colors.white, fontSize: 38, fontWeight: FontWeight.w900)),
              const SizedBox(height: 18),
              _line('Smart Cars', _step(0.5, 0.8), -80,
                  const TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.w900)),
              const SizedBox(height: 6),
              _line('Smart Rides', _step(0.65, 0.95), 80,
                  const TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.w900)),
            ],
          ),
        ),
        ),
      ),
    );
  }
}

const _gold = Color(0xFFD4AF37);
const _goldLight = Color(0xFFF2D675);

/// Diagonal gold and white strips that sweep in from the top-right and bottom-left corners.
class _GoldStripes extends CustomPainter {
  _GoldStripes(this.t) : super(repaint: t);

  final Animation<double> t;

  @override
  void paint(Canvas canvas, Size size) {
    final p = t.value;
    // Each strip is a slanted band: [offset along the diagonal, thickness, colour].
    void band(Offset a, Offset b, double width, Color color, Offset slide) {
      final paint = Paint()
        ..color = color
        ..strokeWidth = width
        ..strokeCap = StrokeCap.butt;
      final d = slide * (1 - p);
      canvas.drawLine(a + d, b + d, paint);
    }

    final w = size.width;
    final h = size.height;
    // top-right corner: white, gold, white
    band(Offset(w * 0.55, -20), Offset(w + 20, h * 0.18), 10, Colors.white, const Offset(300, -120));
    band(Offset(w * 0.68, -20), Offset(w + 20, h * 0.12), 26, _gold, const Offset(300, -120));
    band(Offset(w * 0.86, -20), Offset(w + 20, h * 0.05), 8, _goldLight, const Offset(300, -120));
    // bottom-left corner: gold, white, gold
    band(Offset(-20, h * 0.82), Offset(w * 0.45, h + 20), 8, _goldLight, const Offset(-300, 120));
    band(Offset(-20, h * 0.88), Offset(w * 0.32, h + 20), 26, _gold, const Offset(-300, 120));
    band(Offset(-20, h * 0.95), Offset(w * 0.18, h + 20), 10, Colors.white, const Offset(-300, 120));
  }

  @override
  bool shouldRepaint(_GoldStripes old) => old.t != t;
}
