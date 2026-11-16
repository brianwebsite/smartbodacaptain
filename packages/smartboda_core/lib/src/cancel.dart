import 'package:flutter/material.dart';

class CancelReason {
  const CancelReason(this.id, this.label);

  final String id;
  final String label;
}

// These ids must match the lists in backend/src/vehicles.js.
const List<CancelReason> passengerCancelReasons = [
  CancelReason('changed_mind', 'I changed my mind'),
  CancelReason('wait_too_long', 'Waiting too long'),
  CancelReason('captain_far', 'The captain is too far away'),
  CancelReason('wrong_pickup', 'Wrong pickup or drop-off'),
  CancelReason('found_other_ride', 'I found another ride'),
  CancelReason('price_too_high', 'The price is too high'),
  CancelReason('other', 'Other reason'),
];

const List<CancelReason> captainCancelReasons = [
  CancelReason('passenger_no_show', 'Passenger did not show up'),
  CancelReason('passenger_asked', 'Passenger asked me to cancel'),
  CancelReason('too_far', 'Pickup is too far'),
  CancelReason('vehicle_problem', 'Problem with my vehicle'),
  CancelReason('safety', 'I do not feel safe'),
  CancelReason('other', 'Other reason'),
];

/// Asks why the trip is being cancelled. Returns the reason id, or null if the
/// person decided to keep the trip.
Future<String?> askCancelReason(BuildContext context, {required bool captain}) {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => _CancelSheet(reasons: captain ? captainCancelReasons : passengerCancelReasons),
  );
}

class _CancelSheet extends StatefulWidget {
  const _CancelSheet({required this.reasons});

  final List<CancelReason> reasons;

  @override
  State<_CancelSheet> createState() => _CancelSheetState();
}

class _CancelSheetState extends State<_CancelSheet> {
  String? _picked;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Why are you cancelling?', style: t.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
            const SizedBox(height: 4),
            const Text('This helps us keep rides fair for everyone.'),
            const SizedBox(height: 8),
            for (final r in widget.reasons)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(
                  _picked == r.id ? Icons.radio_button_checked : Icons.radio_button_unchecked,
                  color: _picked == r.id ? Theme.of(context).colorScheme.primary : null,
                ),
                title: Text(r.label),
                onTap: () => setState(() => _picked = r.id),
              ),
            const SizedBox(height: 8),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: Theme.of(context).colorScheme.error),
              onPressed: _picked == null ? null : () => Navigator.of(context).pop(_picked),
              child: const Text('Cancel trip'),
            ),
            const SizedBox(height: 8),
            OutlinedButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Keep my trip')),
          ],
        ),
      ),
    );
  }
}
