import 'dart:async';

import 'package:flutter/material.dart';

import 'api.dart';
import 'format.dart';
import 'models.dart';
import 'theme.dart';
import 'widgets.dart';

/// The Smart Boda wallet: balance, what is held for a trip in progress, and every change.
/// Passengers keep money here to pay trips; captains see what wallet trips earned them.
class WalletScreen extends StatefulWidget {
  const WalletScreen({super.key, required this.api, required this.isCaptain, this.embedded = false, this.phone});

  final ApiClient api;

  /// The person's own number, filled in so the payment prompt goes straight to their phone.
  final String? phone;
  final bool isCaptain;

  /// True when shown as a tab (no back arrow).
  final bool embedded;

  @override
  State<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends State<WalletScreen> {
  WalletInfo? _wallet;
  String? _error;

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
    final w = _wallet;
    if (w != null && !w.topupAvailable) {
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Add money'),
          content: const Text('Adding money by mobile money is not switched on yet. Please try again later or contact Smart Boda.'),
          actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
        ),
      );
      return;
    }
    await showTopupSheet(context, widget.api, phone: widget.phone);
    await _load();
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
                  Text(widget.isCaptain ? 'Commission credit you can use' : 'Smart Boda wallet',
                      style: const TextStyle(color: Colors.white70, fontSize: 14)),
                  const SizedBox(height: 6),
                  AnimatedMoney(widget.isCaptain ? (w?.creditFree ?? 0) : (w?.balance ?? 0), style: t.headlineLarge?.copyWith(color: Colors.white, fontWeight: FontWeight.bold)),
                  if (widget.isCaptain && w != null && (w.creditReserved ?? 0) > 0) ...[
                    const SizedBox(height: 6),
                    Text('${ugx(w.creditReserved!)} more is set aside for trips you accepted',
                        style: const TextStyle(color: Colors.white70)),
                  ],
                  if (w != null && w.held > 0) ...[
                    const SizedBox(height: 6),
                    Text('${ugx(w.held)} is set aside for your trip', style: const TextStyle(color: Colors.white70)),
                  ],
                  ...[
                    const SizedBox(height: 16),
                    FilledButton.icon(
                      style: FilledButton.styleFrom(backgroundColor: Colors.white, foregroundColor: brandPrimary),
                      onPressed: _topup,
                      icon: const Icon(Icons.add),
                      label: Text(widget.isCaptain ? 'Add commission credit' : 'Add money'),
                    ),
                  ],
                ],
              ),
            ),
          ),
          if (widget.isCaptain && w != null) ...[
            const SizedBox(height: 12),
            Card(
              child: ListTile(
                leading: const Icon(Icons.savings_outlined),
                title: Text('Earnings paid through the app: ${ugx(w.balance)}'),
                subtitle: const Text('From trips passengers paid in the app. Smart Boda pays this out to you.'),
              ),
            ),
          ],
          const SizedBox(height: 12),
          Text(
            widget.isCaptain
                ? 'Cash trips: the passenger pays you cash. Smart Boda takes only its commission, from your credit, when the trip is done. '
                    'When you accept a cash trip, its commission is set aside. If the trip is cancelled it comes back. '
                    'You need at least that much free credit to accept a cash trip.'
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

/// The number in the form mobile money takes: 07XXXXXXXX.
String localPhone(String? phone) {
  if (phone == null) return '';
  return phone.startsWith('+256') ? '0${phone.substring(4)}' : phone;
}

/// Opens the top-up sheet. The payment request goes to the phone number given, and the money
/// is added only after LivePay confirms it.
Future<void> showTopupSheet(BuildContext context, ApiClient api, {String? phone}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    isDismissible: false,
    builder: (_) => _TopupSheet(api: api, phone: phone),
  );
}

/// Ask for an amount and a mobile money number, then wait while the person approves on their phone.
class _TopupSheet extends StatefulWidget {
  const _TopupSheet({required this.api, this.phone});

  final ApiClient api;
  final String? phone;

  @override
  State<_TopupSheet> createState() => _TopupSheetState();
}

class _TopupSheetState extends State<_TopupSheet> {
  final _amount = TextEditingController(text: '10000');
  late final _phone = TextEditingController(text: localPhone(widget.phone));
  bool _busy = false;
  bool _waiting = false;
  String? _error;
  String? _result;
  Timer? _poll;
  int _tries = 0;

  @override
  void dispose() {
    _poll?.cancel();
    _amount.dispose();
    _phone.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    final amount = int.tryParse(_amount.text.replaceAll(RegExp(r'[^0-9]'), ''));
    if (amount == null || amount < 1000) {
      setState(() => _error = 'The smallest top-up is UGX 1,000');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await widget.api.post('/api/wallet/topup', {'amount': amount, 'phone': _phone.text.trim()});
      final ref = r['reference'] as String;
      setState(() {
        _waiting = true;
        _tries = 0;
      });
      _poll = Timer.periodic(const Duration(seconds: 5), (_) => _check(ref));
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _check(String ref) async {
    _tries++;
    try {
      final r = await widget.api.get('/api/wallet/topup/$ref');
      final status = r['status'] as String;
      if (status == 'success' || status == 'failed') {
        _poll?.cancel();
        if (mounted) {
          setState(() {
            _waiting = false;
            _result = status == 'success' ? 'success' : 'failed';
          });
        }
        return;
      }
    } on ApiException {
      // Try again on the next beat.
    }
    if (_tries >= 36 && mounted) {
      _poll?.cancel();
      setState(() {
        _waiting = false;
        _result = 'later';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    Widget body;
    if (_result != null) {
      final ok = _result == 'success';
      body = Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Icon(ok ? Icons.check_circle : (_result == 'failed' ? Icons.error_outline : Icons.hourglass_bottom),
              size: 56, color: ok ? Colors.green : brandAccent),
          const SizedBox(height: 8),
          Text(
            ok
                ? 'Money added'
                : (_result == 'failed' ? 'The payment did not go through' : 'We are still waiting for your payment'),
            textAlign: TextAlign.center,
            style: t.headlineSmall,
          ),
          if (_result == 'later')
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text('If you approved it, the money will appear in your wallet within a few minutes.', textAlign: TextAlign.center),
            ),
          const SizedBox(height: 16),
          FilledButton(onPressed: () => Navigator.pop(context), child: const Text('Done')),
        ],
      );
    } else if (_waiting) {
      body = Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Center(child: Pulse(size: 90, child: Icon(Icons.phone_android, color: brandPrimary, size: 36))),
          const SizedBox(height: 12),
          Text('Check your phone', textAlign: TextAlign.center, style: t.headlineSmall),
          const SizedBox(height: 6),
          const Text('Approve the mobile money payment with your PIN. This page updates by itself.', textAlign: TextAlign.center),
        ],
      );
    } else {
      body = Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Add money', style: t.headlineSmall),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            children: [
              for (final a in [5000, 10000, 20000, 50000])
                ActionChip(label: Text(ugx(a)), onPressed: () => setState(() => _amount.text = '$a')),
            ],
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _amount,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'Amount (UGX)'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _phone,
            keyboardType: TextInputType.phone,
            decoration: const InputDecoration(labelText: 'MTN or Airtel number to pay from', hintText: '0772 123456'),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _busy ? null : _start,
            child: _busy
                ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Text('Send payment request'),
          ),
          TextButton(onPressed: _busy ? null : () => Navigator.pop(context), child: const Text('Cancel')),
        ],
      );
    }
    return Padding(
      padding: EdgeInsets.fromLTRB(24, 24, 24, 24 + MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(child: body),
    );
  }
}
