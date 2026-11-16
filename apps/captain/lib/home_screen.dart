import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:smartboda_core/smartboda_core.dart';

import 'earnings_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.session});

  final Session session;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  ApiClient get _api => widget.session.api;
  AppUser get _user => widget.session.user!;

  final MapController _map = MapController();
  Timer? _poll;
  Timer? _beat;

  bool _online = false;
  LatLng? _here;
  List<Offer> _offers = [];
  Trip? _trip;
  String? _error;
  bool _busy = false;

  bool get _approved => _user.status == 'active';

  @override
  void initState() {
    super.initState();
    _online = _user.online;
    _poll = Timer.periodic(const Duration(seconds: 4), (_) => _tick());
    _beat = Timer.periodic(const Duration(seconds: 8), (_) => _sendLocation());
    _tick();
    _locate();
  }

  @override
  void dispose() {
    _poll?.cancel();
    _beat?.cancel();
    super.dispose();
  }

  Future<void> _locate() async {
    final me = await currentLatLng();
    if (!mounted || me == null) return;
    setState(() => _here = me);
    _map.move(me, 15);
  }

  Future<void> _tick() async {
    if (!_approved) {
      // Check whether the admin has approved us yet.
      try {
        await widget.session.refreshUser();
      } on ApiException {
        // Try again on the next tick.
      }
      return;
    }
    try {
      final cur = await _api.get('/api/captain/current');
      final trip = cur['trip'] == null ? null : Trip.fromJson(cur['trip'] as Map<String, dynamic>);
      List<Offer> offers = [];
      if (trip == null && _online) {
        final o = await _api.get('/api/captain/offers');
        offers = (o['offers'] as List<dynamic>)
            .map((e) => Offer.fromJson(e as Map<String, dynamic>))
            .toList();
      }
      if (mounted) {
        setState(() {
          _trip = trip;
          _offers = offers;
          if (trip != null) _online = true;
        });
      }
    } on ApiException {
      // Keep the last state; the next poll retries.
    }
  }

  Future<void> _sendLocation() async {
    if (!_online || !_approved) return;
    final me = await currentLatLng();
    if (me == null) return;
    if (mounted) setState(() => _here = me);
    try {
      await _api.post('/api/captain/location', {'lat': me.latitude, 'lng': me.longitude});
    } on ApiException {
      // Missed one update; the next one fixes it.
    }
  }

  Future<void> _toggleOnline(bool want) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (want) {
        final me = await currentLatLng();
        if (me == null) {
          throw const ApiException('Turn on location to go online. Customers need to know where you are.');
        }
        _here = me;
        await _api.post('/api/captain/presence', {'online': true, 'lat': me.latitude, 'lng': me.longitude});
      } else {
        await _api.post('/api/captain/presence', {'online': false});
      }
      if (mounted) {
        setState(() {
          _online = want;
          if (!want) _offers = [];
        });
      }
      _tick();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _act(String path) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await _api.post(path);
      if (mounted && r['trip'] != null) {
        setState(() => _trip = Trip.fromJson(r['trip'] as Map<String, dynamic>));
      }
      await _tick();
      if (mounted && _trip == null) setState(() {});
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
      await _tick();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _complete(Trip t) async {
    await _act('/api/trips/${t.id}/complete');
    if (!mounted || _error != null) return;
    await showDialog<void>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Trip complete'),
        content: Text('Collect ${ugx(t.fare)} cash from ${t.passenger?.name ?? 'the passenger'}.\n'
            'You keep ${ugx(t.captainEarnings ?? t.fare)} after the Smart Boda fee.'),
        actions: [TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Done'))],
      ),
    );
  }

  List<Marker> _markers() {
    final out = <Marker>[];
    if (_here != null) out.add(dotMarker(_here!));
    final t = _trip;
    if (t != null) {
      out.add(pinMarker(LatLng(t.pickup.lat, t.pickup.lng), color: Colors.green));
      out.add(pinMarker(LatLng(t.dropoff.lat, t.dropoff.lng), color: Colors.red));
    } else {
      for (final o in _offers) {
        out.add(pinMarker(LatLng(o.trip.pickup.lat, o.trip.pickup.lng), color: bodaAmber));
      }
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Smart Boda Captain'),
        actions: [
          IconButton(tooltip: 'My location', icon: const Icon(Icons.my_location), onPressed: _locate),
          PopupMenuButton<String>(
            onSelected: (v) {
              if (v == 'earnings') {
                Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => EarningsScreen(api: _api)));
              } else if (v == 'history') {
                Navigator.of(context).push(
                    MaterialPageRoute<void>(builder: (_) => HistoryScreen(api: _api, showEarnings: true)));
              } else if (v == 'logout') {
                widget.session.logout();
              }
            },
            itemBuilder: (_) => [
              PopupMenuItem(
                  enabled: false,
                  child: Text('${_user.name}\n${_user.bikePlate ?? ''}')),
              const PopupMenuItem(value: 'earnings', child: Text('Earnings')),
              const PopupMenuItem(value: 'history', child: Text('Trip history')),
              const PopupMenuItem(value: 'logout', child: Text('Sign out')),
            ],
          ),
        ],
      ),
      body: !_approved ? _pending(context) : _main(context),
    );
  }

  Widget _pending(BuildContext context) {
    final suspended = _user.status == 'suspended';
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(suspended ? Icons.block : Icons.hourglass_top, size: 64, color: bodaGreen),
            const SizedBox(height: 16),
            Text(suspended ? 'Account suspended' : 'Waiting for approval',
                style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 8),
            Text(
              suspended
                  ? 'Your account is suspended. Please contact Smart Boda.'
                  : 'We are checking your ID, permit and bike. This page updates by itself when you are approved.',
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }

  Widget _main(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: BodaMap(
            controller: _map,
            center: _here ?? kampalaCentre,
            userAgentPackageName: 'ug.smartboda.captain',
            markers: _markers(),
          ),
        ),
        Material(
          elevation: 8,
          child: SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: _trip != null ? _tripPanel(context, _trip!) : _idlePanel(context),
            ),
          ),
        ),
      ],
    );
  }

  Widget _idlePanel(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(_online ? 'You are online' : 'You are offline',
              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
          subtitle: Text(_online ? 'Looking for trips near you' : 'Go online to get trip requests'),
          value: _online,
          onChanged: _busy ? null : _toggleOnline,
        ),
        if (_error != null)
          Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
        if (_online && _offers.isEmpty)
          const Padding(padding: EdgeInsets.only(top: 8), child: LinearProgressIndicator()),
        for (final o in _offers) _OfferCard(offer: o, busy: _busy, onAccept: () => _act('/api/trips/${o.trip.id}/accept'), onDecline: () => _act('/api/trips/${o.trip.id}/decline')),
      ],
    );
  }

  Widget _tripPanel(BuildContext context, Trip t) {
    final String label;
    final String? next;
    switch (t.status) {
      case 'accepted':
        label = 'Go to the pickup';
        next = 'arrived';
        break;
      case 'arrived':
        label = 'Waiting for passenger';
        next = 'start';
        break;
      default:
        label = 'Take the passenger to the drop-off';
        next = 'complete';
    }
    final buttonText = {
      'arrived': "I've arrived",
      'start': 'Start trip',
      'complete': 'Complete trip',
    }[next]!;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(label, style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
        const SizedBox(height: 4),
        Text('${t.passenger?.name ?? ''} · ${t.passenger?.phone ?? ''}'),
        Text('${ugx(t.fare)} cash · you keep ${ugx(t.captainEarnings ?? t.fare)}'),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          ),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: _busy
              ? null
              : () => next == 'complete' ? _complete(t) : _act('/api/trips/${t.id}/$next'),
          child: Text(buttonText),
        ),
        if (t.status == 'accepted' || t.status == 'arrived')
          TextButton(
            onPressed: _busy ? null : () => _act('/api/trips/${t.id}/cancel'),
            child: const Text('Cancel trip'),
          ),
      ],
    );
  }
}

class _OfferCard extends StatelessWidget {
  const _OfferCard({required this.offer, required this.busy, required this.onAccept, required this.onDecline});

  final Offer offer;
  final bool busy;
  final VoidCallback onAccept;
  final VoidCallback onDecline;

  @override
  Widget build(BuildContext context) {
    final t = offer.trip;
    return Card(
      margin: const EdgeInsets.only(top: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('${ugx(t.captainEarnings ?? t.fare)} for you · ${t.distanceKm} km trip',
                style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 17)),
            Text('Pickup is ${offer.distanceToPickupKm} km from you · fare ${ugx(t.fare)} cash'),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(child: OutlinedButton(onPressed: busy ? null : onDecline, child: const Text('Decline'))),
                const SizedBox(width: 8),
                Expanded(child: FilledButton(onPressed: busy ? null : onAccept, child: const Text('Accept'))),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
