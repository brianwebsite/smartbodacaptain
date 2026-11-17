import 'package:flutter/material.dart';

import 'api.dart';
import 'format.dart';
import 'models.dart';
import 'theme.dart';
import 'trip_info_screen.dart';
import 'vehicle.dart';

/// Past trips for the signed-in user (passenger or captain).
class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key, required this.api, this.showEarnings = false});

  final ApiClient api;
  final bool showEarnings;

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  List<Trip>? _trips;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await widget.api.get('/api/trips/history');
      final list = (r['trips'] as List<dynamic>)
          .map((t) => Trip.fromJson(t as Map<String, dynamic>))
          .toList();
      if (mounted) setState(() {
        _trips = list;
        _error = null;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  void _open(Trip t) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => TripInfoScreen(api: widget.api, trip: t, isCaptain: widget.showEarnings),
    ));
  }

  Widget _row(Trip t) {
    final st = tripStatusStyle(t);
    final label = t.isDelivery ? 'Delivery' : vehicleById(t.vehicleType).label;
    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(18),
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: () => _open(t),
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(18), border: Border.all(color: Colors.black12)),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TripBadge(trip: t),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('$label · ${shortDate(t.createdAt)}',
                        style: const TextStyle(fontSize: 12.5, color: Colors.black54, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 10),
                    RouteTimeline(pickup: t.pickup.text, dropoff: t.dropoff.text),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(ugx(t.fare), style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w900)),
                  const SizedBox(height: 8),
                  StatusChip(color: st.color, label: st.label),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final trips = _trips;
    return Scaffold(
      backgroundColor: brandSurface,
      appBar: AppBar(title: const Text('Trip history')),
      body: RefreshIndicator(
        onRefresh: _load,
        child: trips == null
            ? ListView(children: [
                Padding(
                  padding: const EdgeInsets.all(32),
                  child: Center(
                    child: _error != null ? Text(_error!) : const CircularProgressIndicator(),
                  ),
                ),
              ])
            : trips.isEmpty
                ? ListView(children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(32, 80, 32, 32),
                      child: Column(
                        children: const [
                          Icon(Icons.history, size: 56, color: Colors.black26),
                          SizedBox(height: 12),
                          Text('No trips yet', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                          SizedBox(height: 4),
                          Text('Your trips will show up here.', style: TextStyle(color: Colors.black54)),
                        ],
                      ),
                    ),
                  ])
                : ListView.separated(
                    padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
                    itemCount: trips.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 12),
                    itemBuilder: (_, i) => _row(trips[i]),
                  ),
      ),
    );
  }
}
