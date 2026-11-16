import 'package:flutter/material.dart';

import 'api.dart';
import 'format.dart';
import 'models.dart';

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

  @override
  Widget build(BuildContext context) {
    final trips = _trips;
    return Scaffold(
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
                ? ListView(children: const [
                    Padding(padding: EdgeInsets.all(32), child: Center(child: Text('No trips yet.'))),
                  ])
                : ListView.separated(
                    itemCount: trips.length,
                    separatorBuilder: (_, __) => const Divider(height: 1),
                    itemBuilder: (_, i) {
                      final t = trips[i];
                      final amount = widget.showEarnings && t.captainEarnings != null
                          ? t.captainEarnings!
                          : t.fare;
                      return ListTile(
                        title: Text('${t.pickup.text} → ${t.dropoff.text}',
                            maxLines: 2, overflow: TextOverflow.ellipsis),
                        subtitle: Text('${shortDate(t.createdAt)} · ${statusLabel(t.status)}'),
                        trailing: Text(ugx(amount), style: const TextStyle(fontWeight: FontWeight.w600)),
                      );
                    },
                  ),
      ),
    );
  }
}
