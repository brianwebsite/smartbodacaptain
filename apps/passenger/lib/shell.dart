import 'package:flutter/material.dart';
import 'package:smartboda_core/smartboda_core.dart';

import 'account_screen.dart';
import 'home_screen.dart';

/// The signed-in app: Home, Trips, Wallet and Account along the bottom.
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
          HomeScreen(session: widget.session, onOpenWallet: () => setState(() => _tab = 2)),
          _tab == 1 ? HistoryScreen(api: api) : const SizedBox.shrink(),
          _tab == 2 ? WalletScreen(api: api, isCaptain: false, embedded: true) : const SizedBox.shrink(),
          _tab == 3 ? AccountScreen(session: widget.session) : const SizedBox.shrink(),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.map_outlined), selectedIcon: Icon(Icons.map), label: 'Home'),
          NavigationDestination(icon: Icon(Icons.receipt_long_outlined), selectedIcon: Icon(Icons.receipt_long), label: 'Trips'),
          NavigationDestination(
              icon: Icon(Icons.account_balance_wallet_outlined), selectedIcon: Icon(Icons.account_balance_wallet), label: 'Wallet'),
          NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'Account'),
        ],
      ),
    );
  }
}
