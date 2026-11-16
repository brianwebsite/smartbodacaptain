import 'package:flutter/material.dart';

import 'api.dart';
import 'format.dart';
import 'models.dart';
import 'theme.dart';
import 'widgets.dart';

/// The Smart Boda wallet: balance, what is held for a trip in progress, and every change.
/// Passengers keep money here to pay trips; captains see what wallet trips earned them.
class WalletScreen extends StatefulWidget {
  const WalletScreen({super.key, required this.api, required this.isCaptain, this.embedded = false});

  final ApiClient api;
  final bool isCaptain;

  /// True when shown as a tab (no back arrow).
  final bool embedded;

  @override
  State<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends State<WalletScreen> {
  WalletInfo? _wallet;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await widget.api.get('/api/wallet');
      if (mounted) {
        setState(() {
          _wallet = WalletInfo.fromJson(r);
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _topup() async {
    setState(() => _busy = true);
    try {
      await widget.api.post('/api/wallet/topup', {});
    } on ApiException catch (e) {
      if (mounted) {
        await showDialog<void>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('Add money'),
            content: Text(e.message),
            actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final w = _wallet;
    final t = Theme.of(context).textTheme;
    final body = RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(_error!)),
          FadeSlideIn(
            child: Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(20),
                gradient: const LinearGradient(
                  colors: [brandPrimary, brandDark],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(widget.isCaptain ? 'Earned in wallet' : 'Smart Boda wallet',
                      style: const TextStyle(color: Colors.white70, fontSize: 14)),
                  const SizedBox(height: 6),
                  AnimatedMoney(w?.balance ?? 0, style: t.headlineLarge?.copyWith(color: Colors.white, fontWeight: FontWeight.bold)),
                  if (w != null && w.held > 0) ...[
                    const SizedBox(height: 6),
                    Text('${ugx(w.held)} is set aside for your trip', style: const TextStyle(color: Colors.white70)),
                  ],
                  if (!widget.isCaptain) ...[
                    const SizedBox(height: 16),
                    FilledButton.icon(
                      style: FilledButton.styleFrom(backgroundColor: brandAccent, foregroundColor: Colors.black87),
                      onPressed: _busy ? null : _topup,
                      icon: const Icon(Icons.add),
                      label: const Text('Add money'),
                    ),
                  ],
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          Text(
            widget.isCaptain
                ? 'Trips passengers pay from their wallet are credited here. Smart Boda pays this out to you.'
                : 'Pay for trips from your wallet instead of cash. The fare is set aside when you ask for a ride and taken when it ends.',
            style: t.bodySmall,
          ),
          const SizedBox(height: 16),
          Text('Activity', style: t.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          if (w == null && _error == null) const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator())),
          if (w != null && w.entries.isEmpty) const Padding(padding: EdgeInsets.all(12), child: Text('Nothing here yet.')),
          if (w != null)
            for (var i = 0; i < w.entries.length; i++)
              FadeSlideIn(
                delay: Duration(milliseconds: 40 * (i > 8 ? 8 : i)),
                child: ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: CircleAvatar(
                    backgroundColor: (w.entries[i].amount > 0 ? Colors.green : Colors.red).withValues(alpha: 0.12),
                    child: Icon(w.entries[i].amount > 0 ? Icons.south_west : Icons.north_east,
                        color: w.entries[i].amount > 0 ? Colors.green : Colors.red, size: 20),
                  ),
                  title: Text(w.entries[i].label),
                  subtitle: Text(shortDate(w.entries[i].createdAt) + (w.entries[i].note == null ? '' : ' · ${w.entries[i].note}')),
                  trailing: Text(
                    '${w.entries[i].amount > 0 ? '+' : ''}${ugx(w.entries[i].amount)}',
                    style: TextStyle(fontWeight: FontWeight.w700, color: w.entries[i].amount > 0 ? Colors.green[800] : Colors.red[800]),
                  ),
                ),
              ),
        ],
      ),
    );
    if (widget.embedded) return SafeArea(child: body);
    return Scaffold(appBar: AppBar(title: const Text('Wallet')), body: body);
  }
}
