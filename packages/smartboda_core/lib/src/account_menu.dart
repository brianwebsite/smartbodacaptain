import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'api.dart';
import 'faq_screen.dart';
import 'format.dart';
import 'phone_actions.dart';
import 'profile_photo.dart';
import 'push.dart';
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
                        child: CircleAvatar(radius: 11, backgroundColor: Colors.white, child: Icon(Icons.camera_alt, size: 13, color: brandPrimary)),
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
          tile(Icons.notifications_active_outlined, 'Notifications', () => _notificationsDialog(context),
              subtitle: PushService.isOn ? 'On' : 'Tap to allow and test'),
          tile(Icons.phone_forwarded_outlined, 'Backup contact number', () => _backupDialog(context),
              subtitle: u.backupPhone ?? 'Add a second number we can reach you on'),
          tile(Icons.help_outline, 'Help and FAQ',
              () => push(FaqScreen(api: session.api, isCaptain: isCaptain, onContact: () => push(ContactScreen(api: session.api))))),
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

  /// Allow notifications, and send a test to this very phone to prove the whole chain works.
  Future<void> _notificationsDialog(BuildContext context) async {
    String message = PushService.isOn ? 'Notifications are on for this phone.' : 'Checking...';
    var busy = false;
    var started = false;
    await showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setState) {
          Future<void> allow() async {
            setState(() => busy = true);
            final s = await PushService.start(session.api);
            if (!ctx.mounted) return;
            setState(() {
              busy = false;
              message = s == 'on'
                  ? 'Notifications are on for this phone.'
                  : s == 'blocked'
                      ? 'Notifications are blocked. Open your phone Settings, then Apps, Smart Boda, Notifications, and turn them on.'
                      : s;
            });
          }

          Future<void> test() async {
            setState(() => busy = true);
            try {
              final r = await session.api.post('/api/me/push-test', {});
              if (ctx.mounted) setState(() => message = (r['message'] as String?) ?? 'Done.');
            } on ApiException catch (e) {
              if (ctx.mounted) setState(() => message = e.message);
            }
            if (ctx.mounted) setState(() => busy = false);
          }

          if (!started) {
            started = true;
            WidgetsBinding.instance.addPostFrameCallback((_) => allow());
          }
          return AlertDialog(
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(message),
                if (busy) const Padding(padding: EdgeInsets.only(top: 12), child: LinearProgressIndicator()),
                const SizedBox(height: 14),
                FilledButton(onPressed: busy ? null : allow, child: const Text('Allow notifications')),
                const SizedBox(height: 8),
                OutlinedButton(onPressed: busy ? null : test, child: const Text('Send me a test notification')),
              ],
            ),
          );
        },
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
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: ctrl,
                autofocus: true,
                keyboardType: TextInputType.phone,
                decoration: InputDecoration(hintText: '0772 123456', errorText: error),
              ),
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: () async {
                    try {
                      await session.api.put('/api/me/backup-phone', {'phone': ctrl.text.trim()});
                      await session.refreshUser();
                      if (ctx.mounted) Navigator.pop(ctx);
                    } on ApiException catch (e) {
                      setState(() => error = e.message);
                    }
                  },
                  child: const Text('Submit'),
                ),
              ),
            ],
          ),
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

  Widget _section(BuildContext context, String title, List<Widget> children) {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(top: 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Container(width: 4, height: 20, decoration: BoxDecoration(color: const Color(0xFFD4AF37), borderRadius: BorderRadius.circular(2))),
            const SizedBox(width: 8),
            Text(title, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
          ]),
          const SizedBox(height: 10),
          ...children,
        ],
      ),
    );
  }

  Widget _point(IconData icon, String title, String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CircleAvatar(radius: 18, backgroundColor: brandPrimary.withValues(alpha: 0.12), child: Icon(icon, size: 20, color: brandPrimary)),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(height: 2),
                Text(text),
              ],
            ),
          ),
        ],
      ),
    );
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
              padding: EdgeInsets.zero,
              children: [
                Container(
                  padding: const EdgeInsets.fromLTRB(20, 28, 20, 26),
                  decoration: const BoxDecoration(
                    gradient: LinearGradient(colors: [brandPrimary, brandDark], begin: Alignment.topLeft, end: Alignment.bottomRight),
                  ),
                  child: Column(
                    children: [
                      Container(
                        height: 78,
                        width: 78,
                        decoration: const BoxDecoration(shape: BoxShape.circle, color: Colors.white),
                        child: const Icon(Icons.two_wheeler, size: 44, color: brandPrimary),
                      ),
                      const SizedBox(height: 12),
                      const Text('Smart Boda', style: TextStyle(color: Colors.white, fontSize: 30, fontWeight: FontWeight.w900)),
                      const SizedBox(height: 4),
                      const Text('Smart Cars · Smart Rides', style: TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w800)),
                      const SizedBox(height: 16),
                      Row(children: [
                        Expanded(child: Container(height: 3, color: Colors.white)),
                        Expanded(flex: 2, child: Container(height: 3, color: const Color(0xFFD4AF37))),
                        Expanded(child: Container(height: 3, color: Colors.white)),
                      ]),
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 4, 20, 28),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _section(context, 'Who we are', [
                        Text(info.about.isEmpty
                            ? 'Smart Boda is a Kampala ride app. We connect you with trusted boda riders and drivers nearby, '
                                'so getting around the city is quick, fair and safe.'
                            : info.about),
                      ]),
                      _section(context, 'What we offer', [
                        _point(Icons.two_wheeler, 'Boda and electric boda', 'Beat the traffic on a motorcycle, or ride quietly and cleanly on an electric one.'),
                        _point(Icons.directions_car, 'Smart Car', 'A comfortable car for up to 3 passengers.'),
                        _point(Icons.airport_shuttle, 'Smart Car XL', 'More room for up to 6 passengers, for families and groups.'),
                        _point(Icons.inventory_2_outlined, 'Delivery', 'Send a parcel across town with a rider who brings it straight to the door.'),
                      ]),
                      _section(context, 'Why riders trust us', [
                        _point(Icons.pin_outlined, 'Trip code', 'Your rider can only start the trip with the code that is shown on your phone.'),
                        _point(Icons.request_quote_outlined, 'Fair, clear fares', 'You see the price before you ask for a ride. No bargaining.'),
                        _point(Icons.star_outline, 'Ratings you can see', 'Every trip is rated, and you can see your rider\'s name, photo and rating.'),
                        _point(Icons.receipt_long_outlined, 'Receipts', 'Every trip has a receipt in your history, and one is emailed to you.'),
                        _point(Icons.support_agent, 'Real people to help', 'Our support team is one tap away in Contact us.'),
                      ]),
                      if (info.supportPhone.isNotEmpty || info.supportEmail.isNotEmpty)
                        _section(context, 'Get in touch', [
                          if (info.supportPhone.isNotEmpty)
                            ListTile(
                              contentPadding: EdgeInsets.zero,
                              leading: const Icon(Icons.call, color: brandPrimary),
                              title: Text(info.supportPhone),
                              onTap: () => callPhone(context, info.supportPhone),
                            ),
                          if (info.supportEmail.isNotEmpty)
                            ListTile(
                              contentPadding: EdgeInsets.zero,
                              leading: const Icon(Icons.mail_outline, color: brandPrimary),
                              title: Text(info.supportEmail),
                            ),
                        ]),
                      _section(context, 'Follow us', [
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
                      ]),
                      const SizedBox(height: 28),
                      Center(child: Text('Made in Kampala, Uganda', style: t.bodySmall)),
                    ],
                  ),
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
