import 'package:flutter/material.dart';
import 'package:smartboda_core/smartboda_core.dart';

import 'account_screen.dart';
import 'home_screen.dart';

/// The signed-in app: Home, Trips and Account along the bottom. The wallet lives under Account.
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
      // Home stays alive so the map and the trip you are following are not lost.
      // The other tabs are built fresh each time you open them, so they are never stale.
      body: IndexedStack(
        index: _tab,
        children: [
          HomeScreen(
            session: widget.session,
            onOpenWallet: () => showTopupSheet(context, api, phone: widget.session.user?.phone)
                .then((_) => widget.session.refreshUser().catchError((_) {})),
          ),
          _tab == 1 ? HistoryScreen(api: api) : const SizedBox.shrink(),
          _tab == 2 ? AccountScreen(session: widget.session) : const SizedBox.shrink(),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.map_outlined), selectedIcon: Icon(Icons.map), label: 'Home'),
          NavigationDestination(icon: Icon(Icons.receipt_long_outlined), selectedIcon: Icon(Icons.receipt_long), label: 'Trips'),
          NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'Account'),
        ],
      ),
    );
  }
}
