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
                          if (u.email != null) Text(u.email!),
                          if (u.phone != null) Text(u.phone!),
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
                        Text('Fair play', style: t.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
                        const SizedBox(height: 8),
                        const Text(
                          'Captains lose time and money when a trip is cancelled after they have accepted it. '
                          'Cancelling again and again earns a warning, and then a short break from requesting rides. '
                          'Cancelling while we are still finding a captain is always free.',
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              FadeSlideIn(
                delay: const Duration(milliseconds: 160),
                child: Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Night fares', style: t.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
                        const SizedBox(height: 8),
                        const Text('From 10 pm to 5 am fares are a little higher. You always see the exact price before you request.'),
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
