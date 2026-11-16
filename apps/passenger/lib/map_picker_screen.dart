import 'package:flutter/material.dart';
import 'package:latlong2/latlong.dart';
import 'package:smartboda_core/smartboda_core.dart';

/// Drag the map so the pin sits on the right spot, then confirm.
class MapPickerScreen extends StatefulWidget {
  const MapPickerScreen({super.key, required this.api, required this.title, required this.start});

  final ApiClient api;
  final String title;
  final LatLng start;

  @override
  State<MapPickerScreen> createState() => _MapPickerScreenState();
}

class _MapPickerScreenState extends State<MapPickerScreen> {
  late LatLng _centre = widget.start;
  bool _busy = false;

  Future<void> _confirm() async {
    setState(() => _busy = true);
    String? label;
    try {
      final r = await widget.api.get('/api/places/reverse?lat=${_centre.latitude}&lng=${_centre.longitude}');
      final p = r['place'];
      if (p is Map<String, dynamic>) label = p['label'] as String?;
    } on ApiException {
      // Fine: we still have the exact point, just no name for it.
    }
    if (!mounted) return;
    Navigator.of(context).pop(Place(lat: _centre.latitude, lng: _centre.longitude, label: label ?? 'Pinned location'));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: Stack(
        children: [
          BodaMap(
            center: widget.start,
            userAgentPackageName: 'ug.smartboda.passenger',
            onMoved: (c) => _centre = c,
          ),
          const IgnorePointer(
            child: Center(
              child: Padding(
                padding: EdgeInsets.only(bottom: 48),
                child: Icon(Icons.location_on, size: 48, color: Colors.red),
              ),
            ),
          ),
          Align(
            alignment: Alignment.bottomCenter,
            child: SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: FilledButton(
                  onPressed: _busy ? null : _confirm,
                  child: _busy
                      ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : const Text('Confirm this location'),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
