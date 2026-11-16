import 'package:flutter/material.dart';
import 'package:smartboda_core/smartboda_core.dart';

class EarningsScreen extends StatefulWidget {
  const EarningsScreen({super.key, required this.api, this.embedded = false});

  final ApiClient api;
  final bool embedded;

  @override
  State<EarningsScreen> createState() => _EarningsScreenState();
}

class _EarningsScreenState extends State<EarningsScreen> {
  Earnings? _e;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await widget.api.get('/api/captain/earnings?days=7');
      if (mounted) setState(() => _e = Earnings.fromJson(r));
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final e = _e;
    return Scaffold(
      appBar: widget.embedded ? null : AppBar(title: const Text('Earnings')),
      body: SafeArea(child: RefreshIndicator(
        onRefresh: _load,
        child: e == null
            ? ListView(children: [
                Padding(
                  padding: const EdgeInsets.all(32),
                  child: Center(child: _error != null ? Text(_error!) : const CircularProgressIndicator()),
                ),
              ])
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  StandingBanner(e.standing),
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        children: [
                          const Text('Last 7 days, after the Smart Boda fee'),
                          Text(ugx(e.net),
                              style: Theme.of(context)
                                  .textTheme
                                  .headlineLarge
                                  ?.copyWith(fontWeight: FontWeight.bold, color: brandPrimary)),
                          Text('${e.trips} trips · ${ugx(e.gross)} collected · ${ugx(e.commission)} fee'),
                        ],
                      ),
                    ),
                  ),
                  Card(
                    color: e.commissionOwed > 0 ? const Color(0xFFFFF4E0) : null,
                    child: ListTile(
                      leading: const Icon(Icons.account_balance_wallet),
                      title: Text('Fee to pay Smart Boda: ${ugx(e.commissionOwed)}'),
                      subtitle: Text(e.debtLimit > 0
                          ? 'Fees from cash trips. If this goes above ${ugx(e.debtLimit)} you cannot go online until you pay. Wallet trips pay it off automatically.'
                          : 'Fees from cash trips. Pay as agreed with Smart Boda.'),
                    ),
                  ),
                  Card(
                    child: ListTile(
                      leading: const Icon(Icons.savings_outlined),
                      title: Text('Wallet: ${ugx(e.walletBalance)}'),
                      subtitle: const Text('Earned from trips passengers paid by wallet. Smart Boda pays this out to you.'),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => Navigator.of(context).push(
                          MaterialPageRoute<void>(builder: (_) => WalletScreen(api: widget.api, isCaptain: true))),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text('By day', style: Theme.of(context).textTheme.titleMedium),
                  for (final d in e.byDay)
                    ListTile(
                      title: Text(d.day),
                      subtitle: Text('${d.trips} trips'),
                      trailing: Text(ugx(d.net), style: const TextStyle(fontWeight: FontWeight.w600)),
                    ),
                  if (e.byDay.isEmpty) const Padding(padding: EdgeInsets.all(16), child: Text('No trips yet.')),
                ],
              ),
      )),
    );
  }
}
