import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'api.dart';
import 'location.dart';
import 'phone_actions.dart';

const Color _sosRed = Color(0xFFE53935);

/// A red SOS button that glows. It appears while a trip is under way.
class SosButton extends StatefulWidget {
  const SosButton({super.key, required this.onPressed});

  final VoidCallback onPressed;

  @override
  State<SosButton> createState() => _SosButtonState();
}

class _SosButtonState extends State<SosButton> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1100))..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (_, child) => Container(
        width: 58,
        height: 58,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: _sosRed,
          boxShadow: [
            BoxShadow(color: _sosRed.withValues(alpha: 0.35 + 0.4 * _c.value), blurRadius: 8 + 16 * _c.value, spreadRadius: 2 + 8 * _c.value),
          ],
        ),
        child: child,
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: widget.onPressed,
          child: const Center(child: Text('SOS', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w900))),
        ),
      ),
    );
  }
}

/// The emergency sheet: alert Smart Boda, call Smart Boda, call the police, or find a police station.
/// With [reportOnly] it is a quiet "report a problem" for a trip that is over.
Future<void> showEmergencySheet(BuildContext context, ApiClient api, {String? tripId, bool reportOnly = false}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => _EmergencySheet(api: api, tripId: tripId, reportOnly: reportOnly),
  );
}

class _EmergencySheet extends StatefulWidget {
  const _EmergencySheet({required this.api, required this.tripId, required this.reportOnly});

  final ApiClient api;
  final String? tripId;
  final bool reportOnly;

  @override
  State<_EmergencySheet> createState() => _EmergencySheetState();
}

class _EmergencySheetState extends State<_EmergencySheet> {
  late String _category = widget.reportOnly ? 'dispute' : 'emergency';
  final _note = TextEditingController();
  String _emergencyPhone = '0788465140';
  String _policePhone = '999';
  bool _sending = false;
  String? _done;
  String? _error;

  static const _kinds = [
    ('emergency', 'Emergency'),
    ('dispute', 'Dispute'),
    ('fraud', 'Fraud'),
    ('unsafe', 'I feel unsafe'),
    ('other', 'Other'),
  ];

  @override
  void initState() {
    super.initState();
    _loadNumbers();
  }

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _loadNumbers() async {
    try {
      final r = await widget.api.get('/api/app-info');
      final app = r['app'] as Map<String, dynamic>? ?? {};
      if (!mounted) return;
      setState(() {
        final e = (app['emergencyPhone'] as String?)?.trim() ?? '';
        final p = (app['policePhone'] as String?)?.trim() ?? '';
        if (e.isNotEmpty) _emergencyPhone = e;
        if (p.isNotEmpty) _policePhone = p;
      });
    } on ApiException {
      // The built-in numbers still work.
    }
  }

  Future<void> _send() async {
    setState(() {
      _sending = true;
      _error = null;
    });
    // Our position helps, but never wait long for it when someone needs help.
    final here = await currentLatLng().timeout(const Duration(seconds: 4), onTimeout: () => null);
    try {
      await widget.api.post('/api/incidents', {
        'category': _category,
        if (_note.text.trim().isNotEmpty) 'note': _note.text.trim(),
        if (widget.tripId != null) 'tripId': widget.tripId,
        if (here != null) ...{'lat': here.latitude, 'lng': here.longitude},
      });
      if (mounted) {
        setState(() => _done = widget.reportOnly
            ? 'Thank you. Smart Boda has your report and will look into it.'
            : 'Smart Boda has been alerted. Stay safe: we will call you. You can also call us or the police below.');
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = '${e.message}\nPlease call the emergency number below.');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _policeNearby() async {
    final here = await currentLatLng().timeout(const Duration(seconds: 4), onTimeout: () => null);
    final url = here == null
        ? 'https://www.google.com/maps/search/police+station+near+me'
        : 'https://www.google.com/maps/search/police+station/@${here.latitude},${here.longitude},15z';
    var ok = false;
    try {
      ok = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
    } catch (_) {
      ok = false;
    }
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not open the map')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final title = widget.reportOnly ? 'Report a problem' : 'Emergency';
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(widget.reportOnly ? Icons.flag_outlined : Icons.warning_amber_rounded, color: _sosRed, size: 30),
              const SizedBox(width: 10),
              Text(title, style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w900, color: _sosRed)),
            ],
          ),
          const SizedBox(height: 4),
          Text(widget.reportOnly
              ? 'Tell us what went wrong. Smart Boda will look into it.'
              : 'Tell us what is happening and Smart Boda is alerted at once, with your location.'),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 4,
            children: [
              for (final k in _kinds)
                if (!(widget.reportOnly && k.$1 == 'emergency'))
                  ChoiceChip(
                    label: Text(k.$2),
                    selected: _category == k.$1,
                    selectedColor: _sosRed.withValues(alpha: 0.18),
                    onSelected: _sending || _done != null ? null : (_) => setState(() => _category = k.$1),
                  ),
            ],
          ),
          const SizedBox(height: 10),
          if (_done == null)
            TextField(
              controller: _note,
              maxLength: 300,
              maxLines: 2,
              enabled: !_sending,
              decoration: const InputDecoration(hintText: 'What happened? (optional)'),
            ),
          if (_error != null) Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          if (_done != null)
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: Colors.green.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(12)),
              child: Text(_done!, style: const TextStyle(fontWeight: FontWeight.w700)),
            )
          else
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: _sosRed, minimumSize: const Size.fromHeight(54)),
              onPressed: _sending ? null : _send,
              child: _sending
                  ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : Text(widget.reportOnly ? 'Send report' : 'Alert Smart Boda now', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
            ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => callPhone(context, _emergencyPhone),
                  icon: const Icon(Icons.call),
                  label: const Text('Call Smart Boda'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => callPhone(context, _policePhone),
                  icon: const Icon(Icons.local_police_outlined),
                  label: Text('Police $_policePhone'),
                ),
              ),
            ],
          ),
          TextButton.icon(
            onPressed: _policeNearby,
            icon: const Icon(Icons.map_outlined),
            label: const Text('Police stations near me'),
          ),
        ],
      ),
    );
  }
}
