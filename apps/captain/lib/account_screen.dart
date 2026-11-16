import 'package:flutter/material.dart';
import 'package:smartboda_core/smartboda_core.dart';

class AccountScreen extends StatefulWidget {
  const AccountScreen({super.key, required this.session});

  final Session session;

  @override
  State<AccountScreen> createState() => _AccountScreenState();
}

class _AccountScreenState extends State<AccountScreen> {
  @override
  void initState() {
    super.initState();
    widget.session.refreshUser().catchError((_) {});
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.session,
      builder: (context, _) {
        final u = widget.session.user;
        if (u == null) return const SizedBox.shrink();
        final t = Theme.of(context).textTheme;
        final v = vehicleById(u.vehicleType);
        return SafeArea(
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              FadeSlideIn(
                child: Row(
                  children: [
                    CircleAvatar(
                      radius: 32,
                      backgroundColor: brandPrimary,
                      child: Text(
                        u.name.isEmpty ? '?' : u.name.trim()[0].toUpperCase(),
                        style: const TextStyle(color: Colors.white, fontSize: 28, fontWeight: FontWeight.bold),
                      ),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(u.name, style: t.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
                          Text(u.contact),
                          Text('${v.label} · ${u.bikePlate ?? ''}'),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 20),
              StandingBanner(u.standing),
              FadeSlideIn(
                delay: const Duration(milliseconds: 80),
                child: Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('How Smart Boda works for you', style: t.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
                        const SizedBox(height: 8),
                        const Text(
                          'You keep your earnings and pay your own costs. Smart Boda takes a small fee from each trip. '
                          'Cash trips: you collect the money and the fee is added to what you owe. '
                          'Wallet trips: the passenger already paid, and the fee is taken before your share reaches your wallet.',
                        ),
                        const SizedBox(height: 8),
                        const Text(
                          'If what you owe goes over your limit, you cannot go online until you pay. '
                          'Cancelling trips you accepted again and again gets you fewer trips, and then a pause.',
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 24),
              OutlinedButton.icon(
                onPressed: widget.session.logout,
                icon: const Icon(Icons.logout),
                label: const Text('Sign out'),
              ),
            ],
          ),
        );
      },
    );
  }
}
