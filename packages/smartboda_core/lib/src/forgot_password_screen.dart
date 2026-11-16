import 'package:flutter/material.dart';

import 'api.dart';
import 'session.dart';

/// Reset a forgotten password with a 6-digit code sent to the person's email.
class ForgotPasswordScreen extends StatefulWidget {
  const ForgotPasswordScreen({super.key, required this.session, this.email = ''});

  final Session session;
  final String email;

  @override
  State<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends State<ForgotPasswordScreen> {
  late final TextEditingController _email = TextEditingController(text: widget.email);
  final TextEditingController _code = TextEditingController();
  final TextEditingController _password = TextEditingController();

  bool _codeSent = false;
  bool _done = false;
  bool _busy = false;
  bool _hide = true;
  bool? _available;
  String? _error;

  @override
  void initState() {
    super.initState();
    widget.session.passwordResetAvailable().then((ok) {
      if (mounted) setState(() => _available = ok);
    });
  }

  @override
  void dispose() {
    _email.dispose();
    _code.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() job) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await job();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _send() async {
    final email = _email.text.trim();
    if (!RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]{2,}$').hasMatch(email)) {
      setState(() => _error = 'Enter the email address you signed up with');
      return;
    }
    await _run(() async {
      await widget.session.sendResetCode(email);
      if (mounted) setState(() => _codeSent = true);
    });
  }

  Future<void> _reset() async {
    if (_code.text.trim().length != 6) {
      setState(() => _error = 'Enter the 6-digit code from the email');
      return;
    }
    if (_password.text.length < 6) {
      setState(() => _error = 'Use at least 6 characters for the new password');
      return;
    }
    await _run(() async {
      await widget.session.resetPassword(
        email: _email.text.trim(),
        code: _code.text.trim(),
        password: _password.text,
      );
      if (mounted) setState(() => _done = true);
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    Widget body;
    if (_done) {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 32),
          const Icon(Icons.check_circle, size: 72, color: Colors.green),
          const SizedBox(height: 16),
          Text('Password changed', textAlign: TextAlign.center, style: t.headlineSmall?.copyWith(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          const Text('You can sign in with your new password now.', textAlign: TextAlign.center),
          const SizedBox(height: 32),
          FilledButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Back to sign in')),
        ],
      );
    } else if (_available == false) {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: const [
          SizedBox(height: 24),
          Text('Password reset by email is not switched on yet.'),
          SizedBox(height: 8),
          Text('Please contact Smart Boda support and we will reset your password for you.'),
        ],
      );
    } else if (!_codeSent) {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 24),
          Text('Forgot your password?', style: t.headlineSmall?.copyWith(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          const Text('Enter your email address. We will send you a 6-digit code.'),
          const SizedBox(height: 24),
          TextField(
            controller: _email,
            autofocus: true,
            enabled: !_busy,
            keyboardType: TextInputType.emailAddress,
            autocorrect: false,
            decoration: const InputDecoration(labelText: 'Email'),
            onSubmitted: (_) => _busy ? null : _send(),
          ),
          if (_error != null) _errorText(context),
          const SizedBox(height: 24),
          FilledButton(onPressed: _busy || _available == null ? null : _send, child: _label('Send code')),
          const SizedBox(height: 12),
          const Text(
            'Signed up with only a phone number? There is no email to send to, so ask Smart Boda support to reset it.',
          ),
        ],
      );
    } else {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 24),
          Text('Check your email', style: t.headlineSmall?.copyWith(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          Text('If ${_email.text.trim()} has an account, a 6-digit code is on its way. It works for 15 minutes.'),
          const SizedBox(height: 24),
          TextField(
            controller: _code,
            autofocus: true,
            enabled: !_busy,
            keyboardType: TextInputType.number,
            maxLength: 6,
            decoration: const InputDecoration(labelText: '6-digit code', counterText: ''),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _password,
            enabled: !_busy,
            obscureText: _hide,
            decoration: InputDecoration(
              labelText: 'New password',
              suffixIcon: IconButton(
                icon: Icon(_hide ? Icons.visibility : Icons.visibility_off),
                onPressed: () => setState(() => _hide = !_hide),
              ),
            ),
            onSubmitted: (_) => _busy ? null : _reset(),
          ),
          if (_error != null) _errorText(context),
          const SizedBox(height: 24),
          FilledButton(onPressed: _busy ? null : _reset, child: _label('Change password')),
          TextButton(onPressed: _busy ? null : _send, child: const Text('Send a new code')),
        ],
      );
    }
    return Scaffold(
      appBar: AppBar(title: const Text('Reset password')),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 460),
            child: ListView(padding: const EdgeInsets.all(24), children: [body]),
          ),
        ),
      ),
    );
  }

  Widget _errorText(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 12),
        child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
      );

  Widget _label(String text) => _busy
      ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
      : Text(text);
}
