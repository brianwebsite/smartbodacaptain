import 'package:flutter/material.dart';
import 'package:smartboda_core/smartboda_core.dart';

import 'account_screen.dart';
import 'earnings_screen.dart';
import 'home_screen.dart';

/// The signed-in captain app: Home, Earnings, Trips and Account along the bottom.
class Shell extends StatefulWidget {
  const Shell({super.key, required this.session});

  final Session session;

  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final api = widget.session.api;
    return Scaffold(
      body: IndexedStack(
        index: _tab,
        children: [
          HomeScreen(session: widget.session),
          _tab == 1 ? EarningsScreen(api: api, embedded: true) : const SizedBox.shrink(),
          _tab == 2 ? HistoryScreen(api: api, showEarnings: true) : const SizedBox.shrink(),
          _tab == 3 ? AccountScreen(session: widget.session) : const SizedBox.shrink(),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.two_wheeler_outlined), selectedIcon: Icon(Icons.two_wheeler), label: 'Drive'),
          NavigationDestination(icon: Icon(Icons.payments_outlined), selectedIcon: Icon(Icons.payments), label: 'Earnings'),
          NavigationDestination(icon: Icon(Icons.receipt_long_outlined), selectedIcon: Icon(Icons.receipt_long), label: 'Trips'),
          NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'Account'),
        ],
      ),
    );
  }
}
