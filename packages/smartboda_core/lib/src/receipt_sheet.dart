import 'package:flutter/material.dart';

import 'api.dart';
import 'format.dart';

/// Shows the receipt for a finished trip, in plain words.
Future<void> showReceipt(BuildContext context, ApiClient api, String tripId) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => _ReceiptSheet(api: api, tripId: tripId),
  );
}

class _ReceiptSheet extends StatefulWidget {
  const _ReceiptSheet({required this.api, required this.tripId});

  final ApiClient api;
  final String tripId;

  @override
  State<_ReceiptSheet> createState() => _ReceiptSheetState();
}

class _ReceiptSheetState extends State<_ReceiptSheet> {
  Map<String, dynamic>? _r;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await widget.api.get('/api/trips/${widget.tripId}/receipt');
      if (mounted) setState(() => _r = r['receipt'] as Map<String, dynamic>);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Widget _row(String label, String value, {bool bold = false}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: Text(label)),
            const SizedBox(width: 12),
            Flexible(
              child: Text(value,
                  textAlign: TextAlign.right,
                  style: TextStyle(fontWeight: bold ? FontWeight.bold : FontWeight.w500)),
            ),
          ],
        ),
      );

  @override
  Widget build(BuildContext context) {
    final r = _r;
    final t = Theme.of(context).textTheme;
    final Widget body;
    if (r == null) {
      body = Padding(
        padding: const EdgeInsets.all(32),
        child: Center(child: _error != null ? Text(_error!) : const CircularProgressIndicator()),
      );
    } else {
      final rider = r['rider'] as Map<String, dynamic>?;
      final date = r['date'] == null ? null : DateTime.tryParse(r['date'] as String);
      body = Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Receipt ${r['number']}', style: t.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
          if (date != null) Text(shortDate(date.toLocal()), style: t.bodySmall),
          const Divider(height: 24),
          _row('From', (r['pickup'] as String?) ?? 'Pickup point'),
          _row('To', (r['dropoff'] as String?) ?? 'Drop-off point'),
          _row('Distance', '${r['distanceKm']} km'),
          if (rider != null) _row('Rider', '${rider['name']} · ${rider['plate'] ?? ''}'),
          const Divider(height: 24),
          _row('Fare', ugx(r['fare'] as num), bold: true),
          _row('Payment', r['paymentStatus'] as String),
          if (r['commission'] != null) ...[
            const Divider(height: 24),
            _row('Smart Boda commission', ugx(r['commission'] as num)),
            _row('Rider earnings (before costs)', ugx(r['riderEarnings'] as num)),
            const SizedBox(height: 4),
            Text(r['earningsNote'] as String, style: t.bodySmall),
          ],
          if (r['pinVerified'] == true)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text('Trip started with the passenger\'s code.', style: TextStyle(fontSize: 12)),
            ),
        ],
      );
    }
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: SingleChildScrollView(child: body),
      ),
    );
  }
}
