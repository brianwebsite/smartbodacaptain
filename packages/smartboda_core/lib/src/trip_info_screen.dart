import 'package:flutter/material.dart';

import 'api.dart';
import 'emergency.dart';
import 'format.dart';
import 'models.dart';
import 'profile_photo.dart';
import 'theme.dart';
import 'vehicle.dart';

/// The colour and words that go with a trip's status.
({Color color, String label}) tripStatusStyle(Trip t) {
  switch (t.status) {
    case 'completed':
      return (color: const Color(0xFF1B8E3E), label: 'Completed');
    case 'cancelled':
      return (color: const Color(0xFFC62828), label: 'Cancelled');
    case 'no_captain':
      return (color: const Color(0xFF8D6E63), label: 'No captain');
    default:
      return (color: const Color(0xFFB26A00), label: statusLabel(t.status));
  }
}

/// A small coloured pill, for example "Completed".
class StatusChip extends StatelessWidget {
  const StatusChip({super.key, required this.color, required this.label});

  final Color color;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(20)),
      child: Text(label, style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w700)),
    );
  }
}

/// The round logo on the side of a trip: the vehicle, or a parcel for a delivery.
class TripBadge extends StatelessWidget {
  const TripBadge({super.key, required this.trip, this.size = 48});

  final Trip trip;
  final double size;

  @override
  Widget build(BuildContext context) {
    final v = vehicleById(trip.vehicleType);
    final color = trip.isDelivery ? brandPrimary : v.color;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(shape: BoxShape.circle, color: color.withValues(alpha: 0.12)),
      child: Icon(trip.isDelivery ? Icons.inventory_2_outlined : v.icon, color: color, size: size * 0.52),
    );
  }
}

/// Pickup and drop-off joined by a line, one under the other.
class RouteTimeline extends StatelessWidget {
  const RouteTimeline({super.key, required this.pickup, required this.dropoff, this.maxLines = 1});

  final String pickup;
  final String dropoff;
  final int maxLines;

  @override
  Widget build(BuildContext context) {
    Widget line(String text) => Text(text, maxLines: maxLines, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600));
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Column(
            children: [
              const SizedBox(height: 4),
              const Icon(Icons.circle, size: 11, color: brandPrimary),
              Expanded(child: Container(width: 2, margin: const EdgeInsets.symmetric(vertical: 3), color: Colors.black12)),
              const Icon(Icons.location_on, size: 15, color: Colors.red),
            ],
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [line(pickup), const SizedBox(height: 10), line(dropoff)],
            ),
          ),
        ],
      ),
    );
  }
}

/// Everything about one trip, laid out clearly. Opened from the trip history in both apps.
class TripInfoScreen extends StatefulWidget {
  const TripInfoScreen({super.key, required this.api, required this.trip, required this.isCaptain});

  final ApiClient api;
  final Trip trip;
  final bool isCaptain;

  @override
  State<TripInfoScreen> createState() => _TripInfoScreenState();
}

class _TripInfoScreenState extends State<TripInfoScreen> {
  Map<String, dynamic>? _receipt;

  @override
  void initState() {
    super.initState();
    if (widget.trip.status == 'completed') _loadReceipt();
  }

  Future<void> _loadReceipt() async {
    try {
      final r = await widget.api.get('/api/trips/${widget.trip.id}/receipt');
      if (mounted) setState(() => _receipt = r['receipt'] as Map<String, dynamic>);
    } on ApiException {
      // The details above are still useful without the receipt.
    }
  }

  Widget _card({required Widget child, EdgeInsets padding = const EdgeInsets.all(16)}) => Container(
        width: double.infinity,
        margin: const EdgeInsets.only(bottom: 12),
        padding: padding,
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: Colors.black12),
        ),
        child: child,
      );

  Widget _heading(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Text(text.toUpperCase(),
            style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w800, letterSpacing: 1, color: Colors.black45)),
      );

  Widget _row(IconData icon, String label, String value, {bool bold = false}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 7),
        child: Row(
          children: [
            Icon(icon, size: 20, color: Colors.black45),
            const SizedBox(width: 12),
            Expanded(child: Text(label, style: const TextStyle(color: Colors.black54))),
            const SizedBox(width: 12),
            Flexible(
              child: Text(value, textAlign: TextAlign.right, style: TextStyle(fontWeight: bold ? FontWeight.w800 : FontWeight.w600)),
            ),
          ],
        ),
      );

  @override
  Widget build(BuildContext context) {
    final t = widget.trip;
    final v = vehicleById(t.vehicleType);
    final st = tripStatusStyle(t);
    final done = t.status == 'completed';
    final r = _receipt;
    final captain = t.captain;
    final passenger = t.passenger;
    return Scaffold(
      backgroundColor: brandSurface,
      appBar: AppBar(title: Text(t.isDelivery ? 'Delivery details' : 'Trip details')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // The headline: who, how much, and how it ended.
          Container(
            width: double.infinity,
            padding: const EdgeInsets.fromLTRB(18, 18, 18, 20),
            margin: const EdgeInsets.only(bottom: 12),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(22),
              gradient: done
                  ? const LinearGradient(colors: [brandPrimary, brandDark], begin: Alignment.topLeft, end: Alignment.bottomRight)
                  : const LinearGradient(colors: [Color(0xFF6D6D6D), Color(0xFF4A4A4A)], begin: Alignment.topLeft, end: Alignment.bottomRight),
            ),
            child: Column(
              children: [
                Row(
                  children: [
                    Container(
                      width: 46,
                      height: 46,
                      decoration: const BoxDecoration(shape: BoxShape.circle, color: Colors.white),
                      child: Icon(t.isDelivery ? Icons.inventory_2_outlined : v.icon, color: done ? brandPrimary : Colors.black54),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(t.isDelivery ? 'Delivery' : v.label,
                              style: const TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w800)),
                          Text(shortDate(t.createdAt), style: const TextStyle(color: Colors.white)),
                        ],
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(20)),
                      child: Text(st.label, style: TextStyle(color: st.color, fontSize: 12, fontWeight: FontWeight.w800)),
                    ),
                  ],
                ),
                const SizedBox(height: 18),
                Text(t.isDelivery ? 'Delivery amount' : 'Trip amount', style: const TextStyle(color: Colors.white)),
                const SizedBox(height: 2),
                Text(ugx(t.fare), style: const TextStyle(color: Colors.white, fontSize: 38, fontWeight: FontWeight.w900)),
              ],
            ),
          ),

          _card(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _heading('Route'),
                RouteTimeline(pickup: t.pickup.text, dropoff: t.dropoff.text, maxLines: 3),
                const SizedBox(height: 12),
                Row(
                  children: [
                    _pill(Icons.straighten, '${t.distanceKm} km'),
                    const SizedBox(width: 8),
                    _pill(Icons.schedule, 'about ${t.durationMin} min'),
                  ],
                ),
              ],
            ),
          ),

          if (t.isDelivery)
            _card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _heading('Delivery'),
                  _row(Icons.inventory_2_outlined, 'Item', t.deliveryItem ?? '-'),
                  _row(Icons.person_outline, 'Receiver', t.receiverName ?? '-'),
                  if (t.receiverPhone != null) _row(Icons.call_outlined, 'Receiver phone', t.receiverPhone!),
                ],
              ),
            ),

          if (!widget.isCaptain && captain != null)
            _card(
              child: Row(
                children: [
                  ProfileAvatar(api: widget.api, userId: captain.id, name: captain.name, photoVersion: captain.photoVersion, radius: 26),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(captain.name, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                        Text('${captain.bikePlate}${captain.bikeModel == null || captain.bikeModel!.isEmpty ? '' : ' · ${captain.bikeModel}'}',
                            style: const TextStyle(color: Colors.black54)),
                      ],
                    ),
                  ),
                  if (captain.rating != null) ...[
                    const Icon(Icons.star, size: 18, color: brandAccent),
                    const SizedBox(width: 3),
                    Text(captain.rating!.toStringAsFixed(1), style: const TextStyle(fontWeight: FontWeight.w800)),
                  ],
                ],
              ),
            ),
          if (widget.isCaptain && passenger != null)
            _card(
              child: Row(
                children: [
                  CircleAvatar(
                    radius: 24,
                    backgroundColor: brandPrimary.withValues(alpha: 0.12),
                    child: Text(passenger.name.trim().isEmpty ? '?' : passenger.name.trim()[0].toUpperCase(),
                        style: const TextStyle(color: brandPrimary, fontWeight: FontWeight.w800, fontSize: 18)),
                  ),
                  const SizedBox(width: 14),
                  Expanded(child: Text(passenger.name, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800))),
                  if (passenger.rating != null) ...[
                    const Icon(Icons.star, size: 18, color: brandAccent),
                    const SizedBox(width: 3),
                    Text(passenger.rating!.toStringAsFixed(1), style: const TextStyle(fontWeight: FontWeight.w800)),
                  ],
                ],
              ),
            ),

          _card(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _heading('Payment'),
                _row(Icons.payments_outlined, 'Paid with', t.paymentMethod == 'wallet' ? 'Smart Boda wallet' : 'Cash'),
                if (r != null && r['commission'] != null) ...[
                  _row(Icons.percent, 'Smart Boda commission', ugx(r['commission'] as num)),
                  if (r['overrunCommission'] != null)
                    _row(Icons.add_road, 'Extra commission (past the drop-off)', ugx(r['overrunCommission'] as num)),
                  if (r['riderEarnings'] != null) _row(Icons.savings_outlined, 'Paid to you in the app', ugx(r['riderEarnings'] as num), bold: true),
                ],
              ],
            ),
          ),

          if (t.status == 'cancelled' || t.status == 'no_captain')
            _card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _heading(t.status == 'cancelled' ? 'Why it was cancelled' : 'What happened'),
                  Text(
                    t.status == 'no_captain'
                        ? 'No captain was available for this request.'
                        : '${t.cancelledBy == null ? 'Cancelled' : 'Cancelled by the ${t.cancelledBy}'}${t.cancelReason == null ? '' : ': ${t.cancelReason}'}',
                  ),
                ],
              ),
            ),

          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: OutlinedButton.icon(
              onPressed: () => showEmergencySheet(context, widget.api, tripId: t.id, reportOnly: true),
              icon: const Icon(Icons.flag_outlined),
              label: const Text('Report a problem with this trip'),
            ),
          ),

          if (r != null)
            _card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _heading('Receipt'),
                  _row(Icons.receipt_long_outlined, 'Receipt number', '${r['number']}'),
                  if (r['pinVerified'] == true)
                    _row(Icons.verified_outlined, t.isDelivery ? 'Delivery' : 'Trip start',
                        t.isDelivery ? 'Confirmed with the receiver\'s code' : 'Confirmed with the passenger\'s code'),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _pill(IconData icon, String text) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(color: brandSurface, borderRadius: BorderRadius.circular(20)),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 15, color: Colors.black54),
            const SizedBox(width: 5),
            Text(text, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
          ],
        ),
      );
}
