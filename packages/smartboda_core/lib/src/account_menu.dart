import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'api.dart';
import 'format.dart';
import 'phone_actions.dart';
import 'profile_photo.dart';
import 'session.dart';
import 'theme.dart';
import 'wallet_screen.dart';
import 'widgets.dart';

/// Contact details and social links, set by Smart Boda in the admin page.
class AppInfo {
  const AppInfo({
    this.supportPhone = '',
    this.supportEmail = '',
    this.about = '',
    this.androidStoreUrl = '',
    this.links = const {},
  });

  final String supportPhone;
  final String supportEmail;
  final String about;
  final String androidStoreUrl;

  /// Social links by name (whatsapp, facebook, instagram, x, tiktok, youtube). Only those that are set.
  final Map<String, String> links;

  factory AppInfo.fromJson(Map<String, dynamic> j) {
    String s(String k) => (j[k] as String?) ?? '';
    return AppInfo(
      supportPhone: s('supportPhone'),
      supportEmail: s('supportEmail'),
      about: s('about'),
      androidStoreUrl: s('androidStoreUrl'),
      links: {
        for (final k in ['whatsapp', 'facebook', 'instagram', 'x', 'tiktok', 'youtube'])
          if (s(k).isNotEmpty) k: s(k),
      },
    );
  }
}

Future<AppInfo> _loadInfo(ApiClient api) async {
  try {
    return AppInfo.fromJson((await api.get('/api/app-info'))['app'] as Map<String, dynamic>);
  } on ApiException {
    return const AppInfo();
  }
}

Future<void> _open(BuildContext context, String url) async {
  var ok = false;
  try {
    ok = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
  } catch (_) {
    ok = false;
  }
  if (!ok && context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not open that link')));
  }
}

/// The Account page: who you are, then a short list of things you can do.
class AccountMenu extends StatelessWidget {
  const AccountMenu({super.key, required this.session, required this.isCaptain});

  final Session session;
  final bool isCaptain;

  @override
  Widget build(BuildContext context) {
    final u = session.user;
    if (u == null) return const SizedBox.shrink();
    final t = Theme.of(context).textTheme;
    Widget tile(IconData icon, String title, VoidCallback onTap, {String? subtitle}) => Card(
          child: ListTile(
            leading: Icon(icon, color: brandPrimary),
            title: Text(title),
            subtitle: subtitle == null ? null : Text(subtitle),
            trailing: const Icon(Icons.chevron_right),
            onTap: onTap,
          ),
        );
    void push(Widget w) => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => w));
    return SafeArea(
      child: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          FadeSlideIn(
            child: Row(
              children: [
                InkWell(
                  customBorder: const CircleBorder(),
                  onTap: () async {
                    if (await pickAndUploadPhoto(context, session.api)) await session.refreshUser().catchError((_) {});
                  },
                  child: Stack(
                    children: [
                      ProfileAvatar(api: session.api, userId: u.id, name: u.name, photoVersion: u.photoVersion, radius: 32),
                      const Positioned(
                        right: 0,
                        bottom: 0,
                        child: CircleAvatar(radius: 11, backgroundColor: brandAccent, child: Icon(Icons.camera_alt, size: 13, color: Colors.black87)),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(u.name, style: t.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
                      if (isCaptain)
                        Text(
                            u.photoVersion > 0
                                ? 'Passengers see your name and picture'
                                : 'Tap your picture to add a photo. Passengers see it.',
                            style: t.bodySmall),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          StandingBanner(u.standing),
          tile(Icons.payments_outlined, 'Payment methods', () => push(PaymentMethodsScreen(session: session, isCaptain: isCaptain))),
          tile(Icons.account_balance_wallet_outlined, 'Wallet settings',
              () => push(WalletScreen(api: session.api, isCaptain: isCaptain, phone: u.phone))),
          tile(Icons.star_rate_outlined, 'Rate the app on the store', () async {
            final info = await _loadInfo(session.api);
            if (!context.mounted) return;
            if (info.androidStoreUrl.isEmpty) {
              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('The store page is not ready yet. Thank you for your support!')));
            } else {
              await _open(context, info.androidStoreUrl);
            }
          }),
          tile(Icons.info_outline, 'About us', () => push(AboutScreen(api: session.api))),
          tile(Icons.phone_forwarded_outlined, 'Backup contact number', () => _backupDialog(context),
              subtitle: u.backupPhone ?? 'Add a second number we can reach you on'),
          tile(Icons.support_agent, 'Contact us', () => push(ContactScreen(api: session.api))),
          const SizedBox(height: 16),
          OutlinedButton.icon(
            onPressed: session.logout,
            icon: const Icon(Icons.logout),
            label: const Text('Sign out'),
          ),
        ],
      ),
    );
  }

  Future<void> _backupDialog(BuildContext context) async {
    final ctrl = TextEditingController(text: session.user?.backupPhone == null ? '' : localPhone(session.user!.backupPhone));
    String? error;
    await showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setState) => AlertDialog(
          title: const Text('Backup contact number'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('A second number, for example a relative, that Smart Boda can call if we cannot reach you.'),
              TextField(
                controller: ctrl,
                keyboardType: TextInputType.phone,
                decoration: InputDecoration(labelText: 'Phone number', hintText: '0772 123456', errorText: error),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            FilledButton(
              onPressed: () async {
                try {
                  await session.api.put('/api/me/backup-phone', {'phone': ctrl.text.trim()});
                  await session.refreshUser();
                  if (ctx.mounted) Navigator.pop(ctx);
                } on ApiException catch (e) {
                  setState(() => error = e.message);
                }
              },
              child: const Text('Save'),
            ),
          ],
        ),
      ),
    );
  }
}

/// Cash and the Smart Boda wallet. Adding money goes straight to the person's phone.
class PaymentMethodsScreen extends StatefulWidget {
  const PaymentMethodsScreen({super.key, required this.session, required this.isCaptain});

  final Session session;
  final bool isCaptain;

  @override
  State<PaymentMethodsScreen> createState() => _PaymentMethodsScreenState();
}

class _PaymentMethodsScreenState extends State<PaymentMethodsScreen> {
  @override
  void initState() {
    super.initState();
    widget.session.refreshUser().catchError((_) {});
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Payment methods')),
      body: ListenableBuilder(
        listenable: widget.session,
        builder: (context, _) {
          final u = widget.session.user;
          final amount = widget.isCaptain ? (u?.creditFree ?? 0) : (u?.walletAvailable ?? 0);
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Card(
                child: ListTile(
                  leading: const Icon(Icons.payments, color: Colors.green),
                  title: const Text('Cash'),
                  subtitle: Text(widget.isCaptain
                      ? 'The passenger pays you directly. Smart Boda takes its commission from your credit.'
                      : 'Pay the captain directly when the trip ends.'),
                ),
              ),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Icon(Icons.account_balance_wallet, color: brandPrimary),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Text(widget.isCaptain ? 'Commission credit' : 'Smart Boda wallet',
                                style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
                          ),
                          Text(ugx(amount), style: const TextStyle(fontWeight: FontWeight.bold)),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Text(widget.isCaptain
                          ? 'Add credit with mobile money. It is used for the commission on cash trips.'
                          : 'Add money with mobile money, then pay trips from the app.'),
                      const SizedBox(height: 12),
                      FilledButton.icon(
                        onPressed: () async {
                          await showTopupSheet(context, widget.session.api, phone: u?.phone);
                          await widget.session.refreshUser().catchError((_) {});
                        },
                        icon: const Icon(Icons.add),
                        label: const Text('Add money'),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class AboutScreen extends StatefulWidget {
  const AboutScreen({super.key, required this.api});

  final ApiClient api;

  @override
  State<AboutScreen> createState() => _AboutScreenState();
}

class _AboutScreenState extends State<AboutScreen> {
  AppInfo? _info;

  @override
  void initState() {
    super.initState();
    _loadInfo(widget.api).then((i) {
      if (mounted) setState(() => _info = i);
    });
  }

  // Brand-coloured badges. A letter or a plain icon stands for each network.
  static const _badges = <String, (Color, String)>{
    'whatsapp': (Color(0xFF25D366), 'WhatsApp'),
    'facebook': (Color(0xFF1877F2), 'Facebook'),
    'instagram': (Color(0xFFE4405F), 'Instagram'),
    'x': (Color(0xFF111111), 'X'),
    'tiktok': (Color(0xFF111111), 'TikTok'),
    'youtube': (Color(0xFFFF0000), 'YouTube'),
  };

  Widget _glyph(String key) {
    switch (key) {
      case 'whatsapp':
        return const Icon(Icons.chat, color: Colors.white, size: 26);
      case 'facebook':
        return const Icon(Icons.facebook, color: Colors.white, size: 30);
      case 'instagram':
        return const Icon(Icons.camera_alt_outlined, color: Colors.white, size: 26);
      case 'tiktok':
        return const Icon(Icons.music_note, color: Colors.white, size: 26);
      case 'youtube':
        return const Icon(Icons.play_arrow_rounded, color: Colors.white, size: 32);
      default:
        return const Text('X', style: TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.bold));
    }
  }

  @override
  Widget build(BuildContext context) {
    final info = _info;
    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('About us')),
      body: info == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(20),
              children: [
                Text('Smart Boda', style: t.headlineMedium?.copyWith(fontWeight: FontWeight.bold, color: brandPrimary)),
                const SizedBox(height: 12),
                Text(info.about.isEmpty ? 'Smart Boda connects you with trusted riders and drivers in Kampala.' : info.about),
                const SizedBox(height: 24),
                Text('Follow us', style: t.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
                const SizedBox(height: 12),
                if (info.links.isEmpty)
                  const Text('Our social pages are coming soon.')
                else
                  Wrap(
                    spacing: 16,
                    runSpacing: 16,
                    children: [
                      for (final e in info.links.entries)
                        if (_badges[e.key] != null)
                          Tooltip(
                            message: _badges[e.key]!.$2,
                            child: InkWell(
                              onTap: () => _open(context, e.value),
                              borderRadius: BorderRadius.circular(30),
                              child: CircleAvatar(
                                radius: 28,
                                backgroundColor: _badges[e.key]!.$1,
                                child: _glyph(e.key),
                              ),
                            ),
                          ),
                    ],
                  ),
              ],
            ),
    );
  }
}

class ContactScreen extends StatefulWidget {
  const ContactScreen({super.key, required this.api});

  final ApiClient api;

  @override
  State<ContactScreen> createState() => _ContactScreenState();
}

class _ContactScreenState extends State<ContactScreen> {
  AppInfo? _info;

  @override
  void initState() {
    super.initState();
    _loadInfo(widget.api).then((i) {
      if (mounted) setState(() => _info = i);
    });
  }

  @override
  Widget build(BuildContext context) {
    final info = _info;
    return Scaffold(
      appBar: AppBar(title: const Text('Contact us')),
      body: info == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                if (info.supportPhone.isNotEmpty)
                  Card(
                    child: ListTile(
                      leading: const Icon(Icons.call, color: brandPrimary),
                      title: const Text('Call us'),
                      subtitle: Text(info.supportPhone),
                      onTap: () => callPhone(context, info.supportPhone),
                    ),
                  ),
                if (info.links['whatsapp'] != null)
                  Card(
                    child: ListTile(
                      leading: const Icon(Icons.chat, color: Color(0xFF25D366)),
                      title: const Text('Chat on WhatsApp'),
                      onTap: () => _open(context, info.links['whatsapp']!),
                    ),
                  ),
                if (info.supportEmail.isNotEmpty)
                  Card(
                    child: ListTile(
                      leading: const Icon(Icons.email_outlined, color: brandPrimary),
                      title: const Text('Email us'),
                      subtitle: Text(info.supportEmail),
                      onTap: () => _open(context, 'mailto:${info.supportEmail}'),
                    ),
                  ),
                if (info.supportPhone.isEmpty && info.supportEmail.isEmpty && info.links['whatsapp'] == null)
                  const Padding(
                    padding: EdgeInsets.all(24),
                    child: Text('Our contact details will be here soon.'),
                  ),
              ],
            ),
    );
  }
}
