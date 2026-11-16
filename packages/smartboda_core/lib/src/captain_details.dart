import 'package:flutter/material.dart';

import 'format.dart';
import 'models.dart';
import 'phone_actions.dart';
import 'theme.dart';
import 'vehicle.dart';

/// Five stars filled to the given rating (0 to 5).
class Stars extends StatelessWidget {
  const Stars(this.value, {super.key, this.size = 18});

  final double value;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 1; i <= 5; i++)
          Icon(
            value >= i - 0.25 ? Icons.star : (value >= i - 0.75 ? Icons.star_half : Icons.star_border),
            size: size,
            color: brandAccent,
          ),
      ],
    );
  }
}

/// Everything a passenger should know about their captain, laid out clearly.
Future<void> showCaptainDetails(BuildContext context, CaptainInfo c, {VoidCallback? onMessage}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (sheetContext) => _CaptainDetails(captain: c, onMessage: onMessage),
  );
}

class _CaptainDetails extends StatelessWidget {
  const _CaptainDetails({required this.captain, this.onMessage});

  final CaptainInfo captain;
  final VoidCallback? onMessage;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final v = vehicleById(captain.vehicleType);
    final c = captain;
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                CircleAvatar(
                  radius: 32,
                  backgroundColor: brandPrimary,
                  child: Text(
                    c.name.isEmpty ? '?' : c.name.trim()[0].toUpperCase(),
                    style: const TextStyle(fontSize: 28, color: Colors.white, fontWeight: FontWeight.bold),
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(c.name, style: t.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
                      const SizedBox(height: 4),
                      if (c.rating != null)
                        Row(children: [
                          Stars(c.rating!),
                          const SizedBox(width: 6),
                          Text('${c.rating!.toStringAsFixed(1)} (${c.ratingCount})'),
                        ])
                      else
                        const Text('New captain, no ratings yet'),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(child: _Fact(label: 'Trips', value: '${c.completedTrips}')),
                const SizedBox(width: 8),
                Expanded(child: _Fact(label: 'With Smart Boda since', value: c.memberSince == null ? '-' : monthYear(c.memberSince!))),
              ],
            ),
            const SizedBox(height: 16),
            Card(
              margin: EdgeInsets.zero,
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    Icon(v.icon, size: 40, color: v.color),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(v.label, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
                          if (c.bikeModel != null && c.bikeModel!.isNotEmpty) Text(c.bikeModel!),
                          if (c.stageName != null && c.stageName!.isNotEmpty) Text('Stage: ${c.stageName}'),
                        ],
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      decoration: BoxDecoration(
                        color: brandAccent,
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(color: Colors.black87, width: 1.5),
                      ),
                      child: Text(c.bikePlate,
                          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16, letterSpacing: 1)),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: FilledButton.icon(
                    style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                    onPressed: () => callPhone(context, c.phone),
                    icon: const Icon(Icons.call),
                    label: const Text('Call'),
                  ),
                ),
                if (onMessage != null) ...[
                  const SizedBox(width: 12),
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: () {
                        Navigator.of(context).pop();
                        onMessage!();
                      },
                      icon: const Icon(Icons.chat_bubble_outline),
                      label: const Text('Message'),
                    ),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.04), borderRadius: BorderRadius.circular(12)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          const SizedBox(height: 2),
          Text(label, style: const TextStyle(fontSize: 12)),
        ],
      ),
    );
  }
}
