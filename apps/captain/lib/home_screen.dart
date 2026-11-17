import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:smartboda_core/smartboda_core.dart';


class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.session});

  final Session session;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _ticks = 0;
  Trip? _lastTrip;
  final Set<String> _doneShown = {};
  ApiClient get _api => widget.session.api;
  late final RouteFinder _roads = RouteFinder(_api);

  void _redraw() {
    if (mounted) setState(() {});
  }
  AppUser get _user => widget.session.user!;

  final MapController _map = MapController();
  Timer? _poll;
  Timer? _beat;

  bool _online = false;
  LatLng? _here;
  List<Offer> _offers = [];
  Trip? _trip;
  String? _error;
  int? _creditNeeded;
  bool _busy = false;

  bool get _approved => _user.status == 'active';

  @override
  void initState() {
    super.initState();
    _online = _user.online;
    _poll = Timer.periodic(const Duration(seconds: 3), (_) => _tick());
    // Often enough for the passenger to watch you come, and for the app to notice arrival.
    _beat = Timer.periodic(const Duration(seconds: 4), (_) => _sendLocation());
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
    _ticks++;
    if (_ticks % 8 == 0) widget.session.refreshUser().catchError((_) {});
    try {
      final cur = await _api.get('/api/captain/current');
      final trip = cur['trip'] == null ? null : Trip.fromJson(cur['trip'] as Map<String, dynamic>);
      final before = _lastTrip;
      _lastTrip = trip;
      if (trip == null && before != null && before.status == 'in_progress') {
        // The phone ended the trip by itself when we reached the drop-off.
        _afterTripEnded(before);
      }
      List<Offer> offers = [];
      int? creditNeeded;
      if (trip == null && _online) {
        final o = await _api.get('/api/captain/offers');
        creditNeeded = ((o['credit'] as Map<String, dynamic>?)?['creditNeeded'] as num?)?.toInt();
        offers = (o['offers'] as List<dynamic>)
            .map((e) => Offer.fromJson(e as Map<String, dynamic>))
            .toList();
      }
      if (mounted) {
        setState(() {
          _trip = trip;
          _offers = offers;
          _creditNeeded = creditNeeded;
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

  Future<void> _act(String path, [Map<String, dynamic>? body]) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await _api.post(path, body);
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

  Future<String?> _askCode({required String title, required String helper, required String button}) async {
    final ctrl = TextEditingController();
    final pin = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          keyboardType: TextInputType.number,
          maxLength: 4,
          decoration: InputDecoration(helperText: helper),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()), child: Text(button)),
        ],
      ),
    );
    return pin == null || pin.isEmpty ? null : pin;
  }

  /// A ride starts with the passenger's 4-digit code (the right person is on board).
  /// A delivery starts with no code: its code is asked for at the end, at the drop-off.
  Future<void> _start(Trip t) async {
    if (t.isDelivery) {
      await _act('/api/trips/${t.id}/start');
      return;
    }
    final pin = await _askCode(title: 'Trip code', helper: 'Ask the passenger for the 4-digit code in their app.', button: 'Start');
    if (pin == null) return;
    await _act('/api/trips/${t.id}/start', {'pin': pin});
  }

  Future<void> _cancel(Trip t) async {
    final reason = await askCancelReason(context, captain: true);
    if (reason == null) return;
    await _act('/api/trips/${t.id}/cancel', {'reason': reason});
  }

  void _openChat(Trip t) {
    final p = t.passenger;
    if (p == null) return;
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => ChatScreen(
        api: _api,
        tripId: t.id,
        title: p.name,
        quickReplies: const ["I'm on my way", "I'm at the pickup", 'Where exactly are you?', 'Please come out'],
      ),
    ));
  }

  Future<void> _complete(Trip t) async {
    Map<String, dynamic>? body;
    if (t.isDelivery) {
      // The receiver's code confirms the delivery reached them.
      final pin = await _askCode(title: 'Delivery code', helper: 'Ask the receiver for the 4-digit delivery code.', button: 'Confirm');
      if (pin == null) return;
      body = {'pin': pin};
    }
    await _act('/api/trips/${t.id}/complete', body);
    if (!mounted || _error != null) return;
    _lastTrip = null;
    await _showTripDone(t);
  }

  /// Looks up how a trip ended after the server finished it for us.
  Future<void> _afterTripEnded(Trip before) async {
    try {
      final r = await _api.get('/api/trips/${before.id}');
      final done = Trip.fromJson(r['trip'] as Map<String, dynamic>);
      if (done.status == 'completed' && mounted) await _showTripDone(done);
    } on ApiException {
      // Not worth bothering the captain about.
    }
  }

  /// What the captain should collect, and a quick rating of the passenger.
  Future<void> _showTripDone(Trip t) async {
    if (!_doneShown.add(t.id)) return;
    widget.session.refreshUser().catchError((_) {});
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      isDismissible: false,
      builder: (_) => _TripDoneSheet(api: _api, trip: t),
    );
  }

  /// The road to the pickup, then to the drop-off.
  List<Polyline> _lines() {
    final t = _trip;
    final here = _here;
    if (t == null || here == null) return const [];
    final pickup = LatLng(t.pickup.lat, t.pickup.lng);
    final dropoff = LatLng(t.dropoff.lat, t.dropoff.lng);
    if (t.status == 'in_progress') return [RouteFinder.draw(_roads.line(here, dropoff, _redraw))];
    return [RouteFinder.draw(_roads.line(here, pickup, _redraw))];
  }

  List<Marker> _markers() {
    final out = <Marker>[];
    if (_here != null) out.add(vehicleMarker(_here!, _user.vehicleType, big: true));
    final t = _trip;
    if (t != null) {
      out.add(pinMarker(LatLng(t.pickup.lat, t.pickup.lng), color: brandPrimary));
      out.add(pinMarker(LatLng(t.dropoff.lat, t.dropoff.lng), color: Colors.red));
    } else {
      for (final o in _offers) {
        out.add(pinMarker(LatLng(o.trip.pickup.lat, o.trip.pickup.lng), color: brandAccent));
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
            Icon(suspended ? Icons.block : Icons.hourglass_top, size: 64, color: brandPrimary),
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
            lines: _lines(),
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
        StandingBanner(_user.standing),
        _creditBanner(),
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
        for (final o in _offers) FadeSlideIn(child: _OfferCard(offer: o, busy: _busy, onAccept: () => _act('/api/trips/${o.trip.id}/accept'), onDecline: () => _act('/api/trips/${o.trip.id}/decline'))),
      ],
    );
  }

  /// Says how much commission credit is missing to see cash trips.
  Widget _creditBanner() {
    final needed = _creditNeeded;
    final low = _user.creditFree < 1000;
    if (needed == null && !low) return const SizedBox.shrink();
    return FadeSlideIn(
      child: Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: const Color(0xFFB26A00).withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: const Color(0xFFB26A00)),
        ),
        child: Row(
          children: [
            const Icon(Icons.account_balance_wallet_outlined, color: Color(0xFFB26A00)),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                needed != null
                    ? 'A cash trip near you needs ${ugx(needed)} more commission credit. Add credit to accept it.'
                    : 'Your commission credit is ${ugx(_user.creditFree)}. Add credit to accept cash trips. Trips paid in the app still work.',
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ),
            TextButton(
              onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(builder: (_) => WalletScreen(api: _api, isCaptain: true))),
              child: const Text('Add'),
            ),
          ],
        ),
      ),
    );
  }

  /// While driving to the drop-off nothing else is shown. The slide to finish appears when close.
  Widget _drivingPanel(BuildContext context, Trip t) {
    final here = _here;
    final km = here == null ? null : kmBetween(here, LatLng(t.dropoff.lat, t.dropoff.lng));
    final near = km == null || km <= 0.5; // without a location fix we cannot tell, so do not hide it
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 350),
      child: near
          ? Column(
              key: const ValueKey('finish'),
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                  ),
                SlideToConfirm(
                  key: ValueKey('${t.id}-complete'),
                  label: t.isDelivery ? 'Delivered' : 'Complete trip',
                  color: Colors.green.shade700,
                  enabled: !_busy,
                  onConfirmed: () => _complete(t),
                ),
              ],
            )
          : Padding(
              key: const ValueKey('driving'),
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Text(
                '${km.toStringAsFixed(1)} km to the drop-off',
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
              ),
            ),
    );
  }

  Widget _tripPanel(BuildContext context, Trip t) {
    if (t.status == 'in_progress') return _drivingPanel(context, t);
    final String label;
    final String? next;
    switch (t.status) {
      case 'accepted':
        label = 'Go to the pickup';
        next = 'arrived';
        break;
      case 'arrived':
        label = t.isDelivery ? 'Collect the item' : 'Waiting for passenger';
        next = 'start';
        break;
      default:
        label = t.isDelivery ? 'Deliver the item' : 'Take the passenger to the drop-off';
        next = 'complete';
    }
    final buttonText = {
      'arrived': "I've arrived",
      'start': t.isDelivery ? 'Start delivery' : 'Start trip',
      'complete': t.isDelivery ? 'Delivered' : 'Complete trip',
    }[next]!;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(label, style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
        const SizedBox(height: 4),
        const SizedBox(height: 8),
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(border: Border.all(color: Colors.black12), borderRadius: BorderRadius.circular(14)),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  CircleAvatar(
                    backgroundColor: brandPrimary,
                    child: Text(
                      (t.passenger?.name ?? '?').trim().isEmpty ? '?' : t.passenger!.name.trim()[0].toUpperCase(),
                      style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(children: [
                          Flexible(
                            child: Text(t.passenger?.name ?? 'Passenger',
                                style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600), overflow: TextOverflow.ellipsis),
                          ),
                          if (t.passenger?.rating != null) ...[
                            const SizedBox(width: 8),
                            const Icon(Icons.star, size: 16, color: brandAccent),
                            Text(t.passenger!.rating!.toStringAsFixed(1)),
                          ],
                        ]),
                        Text(t.status == 'in_progress' ? 'To: ${t.dropoff.text}' : 'Pickup: ${t.pickup.text}',
                            maxLines: 2, overflow: TextOverflow.ellipsis),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: t.passenger?.phone == null ? null : () => callPhone(context, t.passenger!.phone!),
                      icon: const Icon(Icons.call),
                      label: const Text('Call'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: () => _openChat(t),
                      icon: Badge(
                        label: Text('${t.unread}'),
                        isLabelVisible: t.unread > 0,
                        child: const Icon(Icons.chat_bubble_outline),
                      ),
                      label: const Text('Message'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        if (t.isDelivery)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: brandSurface, borderRadius: BorderRadius.circular(12)),
              child: Row(
                children: [
                  const Icon(Icons.inventory_2_outlined, color: brandPrimary),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(t.deliveryItem ?? 'Item', style: const TextStyle(fontWeight: FontWeight.w700)),
                        Text('Receiver: ${t.receiverName ?? ''}'),
                      ],
                    ),
                  ),
                  if (t.receiverPhone != null)
                    IconButton(
                      tooltip: 'Call receiver',
                      icon: const Icon(Icons.call),
                      onPressed: () => callPhone(context, t.receiverPhone!),
                    ),
                ],
              ),
            ),
          ),
        const SizedBox(height: 8),
        Text(
          t.paymentMethod == 'wallet'
              ? '${ugx(t.fare)} paid from the passenger wallet · ${ugx(t.captainEarnings ?? t.fare)} goes to your wallet · ${t.distanceKm} km'
              : '${ugx(t.fare)} cash · ${t.distanceKm} km',
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          ),
        const SizedBox(height: 12),
        if (next == 'arrived')
          FilledButton(
            onPressed: _busy ? null : () => _act('/api/trips/${t.id}/$next'),
            child: Text(buttonText),
          )
        else
          // Starting and finishing a trip need a deliberate slide, not a tap.
          SlideToConfirm(
            key: ValueKey('${t.id}-$next'),
            label: buttonText,
            color: next == 'complete' ? Colors.green.shade700 : brandPrimary,
            enabled: !_busy,
            onConfirmed: () => next == 'complete' ? _complete(t) : _start(t),
          ),
        if (t.status == 'accepted' || t.status == 'arrived')
          TextButton(
            onPressed: _busy ? null : () => _cancel(t),
            child: Text('Cancel trip', style: TextStyle(color: Theme.of(context).colorScheme.error)),
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
            Row(
              children: [
                if (t.isDelivery) const Padding(padding: EdgeInsets.only(right: 6), child: Icon(Icons.inventory_2_outlined, size: 20, color: brandPrimary)),
                Expanded(
                  child: Text(
                      '${t.isDelivery ? 'Delivery · ' : ''}${t.paymentMethod == 'wallet' ? '${ugx(t.captainEarnings ?? t.fare)} for you, paid in the app' : '${ugx(t.fare)} cash'} · ${t.distanceKm} km',
                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 17)),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Row(children: [
              const Icon(Icons.trip_origin, size: 16, color: brandPrimary),
              const SizedBox(width: 6),
              Expanded(child: Text(t.pickup.text, maxLines: 1, overflow: TextOverflow.ellipsis)),
            ]),
            Row(children: [
              const Icon(Icons.location_on, size: 16, color: Colors.red),
              const SizedBox(width: 6),
              Expanded(child: Text(t.dropoff.text, maxLines: 1, overflow: TextOverflow.ellipsis)),
            ]),
            const SizedBox(height: 4),
            Text('Pickup is ${offer.distanceToPickupKm} km from you · about ${etaMinutes(offer.distanceToPickupKm)} min · fare ${ugx(t.fare)} ${t.paymentMethod == 'wallet' ? 'from wallet' : 'cash'}'),
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

class _TripDoneSheet extends StatefulWidget {
  const _TripDoneSheet({required this.api, required this.trip});

  final ApiClient api;
  final Trip trip;

  @override
  State<_TripDoneSheet> createState() => _TripDoneSheetState();
}

class _TripDoneSheetState extends State<_TripDoneSheet> {
  int _stars = 5;
  bool _busy = false;

  Future<void> _send() async {
    setState(() => _busy = true);
    try {
      await widget.api.post('/api/trips/${widget.trip.id}/rate-passenger', {'rating': _stars});
    } on ApiException {
      // A missed rating is not worth blocking the captain.
    }
    if (mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.trip;
    return Padding(
      padding: EdgeInsets.fromLTRB(24, 24, 24, 24 + MediaQuery.of(context).viewInsets.bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Icon(Icons.check_circle, color: Colors.green, size: 56),
          const SizedBox(height: 8),
          Text(t.isDelivery ? 'Delivery complete' : 'Trip complete',
              textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 10),
          AmountSummary(label: t.isDelivery ? 'Delivery amount' : 'Trip amount', amount: ugx(t.fare)),
          const SizedBox(height: 18),
          Text('Rate ${t.passenger?.name ?? 'the passenger'}', textAlign: TextAlign.center),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              for (var i = 1; i <= 5; i++)
                IconButton(
                  iconSize: 38,
                  onPressed: () => setState(() => _stars = i),
                  icon: Icon(i <= _stars ? Icons.star : Icons.star_border, color: brandAccent),
                ),
            ],
          ),
          FilledButton(onPressed: _busy ? null : _send, child: const Text('Done')),
        ],
      ),
    );
  }
}
