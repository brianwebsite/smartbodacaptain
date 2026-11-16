import 'package:flutter/material.dart';

import 'api.dart';
import 'session.dart';
import 'theme.dart';

/// Sign in / create account. Captains get extra fields (bike, ID, permit).
class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key, required this.session, required this.appTitle});

  final Session session;
  final String appTitle;

  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  final _form = GlobalKey<FormState>();
  bool _register = false;
  bool _busy = false;
  bool _hide = true;
  String? _error;

  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _password = TextEditingController();
  final _plate = TextEditingController();
  final _model = TextEditingController();
  final _nationalId = TextEditingController();
  final _permit = TextEditingController();
  final _stage = TextEditingController();

  bool get _isCaptain => widget.session.role == 'captain';

  @override
  void dispose() {
    for (final c in [_name, _phone, _password, _plate, _model, _nationalId, _permit, _stage]) {
      c.dispose();
    }
    super.dispose();
  }

  String? _required(String? v, [int min = 1]) =>
      (v == null || v.trim().length < min) ? 'Required' : null;

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_register) {
        await widget.session.register({
          'name': _name.text.trim(),
          'phone': _phone.text.trim(),
          'password': _password.text,
          if (_isCaptain) ...{
            'bikePlate': _plate.text.trim(),
            'bikeModel': _model.text.trim(),
            'nationalId': _nationalId.text.trim(),
            'permitNumber': _permit.text.trim(),
            'stageName': _stage.text.trim(),
          },
        });
      } else {
        await widget.session.login(_phone.text.trim(), _password.text);
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _field(TextEditingController c, String label,
      {TextInputType? type, String? Function(String?)? validator, TextCapitalization cap = TextCapitalization.none}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextFormField(
        controller: c,
        keyboardType: type,
        textCapitalization: cap,
        decoration: InputDecoration(labelText: label),
        validator: validator,
        enabled: !_busy,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Form(
                key: _form,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Icon(Icons.two_wheeler, size: 64, color: bodaGreen),
                    const SizedBox(height: 8),
                    Text(widget.appTitle,
                        textAlign: TextAlign.center,
                        style: Theme.of(context)
                            .textTheme
                            .headlineMedium
                            ?.copyWith(fontWeight: FontWeight.bold, color: bodaGreen)),
                    const SizedBox(height: 4),
                    Text(_register ? 'Create your account' : 'Sign in to continue',
                        textAlign: TextAlign.center),
                    const SizedBox(height: 24),
                    if (_register) _field(_name, 'Full name', cap: TextCapitalization.words, validator: (v) => _required(v, 2)),
                    _field(_phone, 'Phone number (0772 123456)',
                        type: TextInputType.phone, validator: (v) => _required(v, 9)),
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: TextFormField(
                        controller: _password,
                        obscureText: _hide,
                        enabled: !_busy,
                        decoration: InputDecoration(
                          labelText: 'Password',
                          helperText: _register ? 'At least 6 characters' : null,
                          suffixIcon: IconButton(
                            icon: Icon(_hide ? Icons.visibility : Icons.visibility_off),
                            onPressed: () => setState(() => _hide = !_hide),
                          ),
                        ),
                        validator: (v) => (v == null || v.length < 6) ? 'At least 6 characters' : null,
                      ),
                    ),
                    if (_register && _isCaptain) ...[
                      const Divider(height: 28),
                      const Text('Your bike and documents',
                          style: TextStyle(fontWeight: FontWeight.w600)),
                      const SizedBox(height: 4),
                      const Text('We check these before you can take trips.'),
                      const SizedBox(height: 12),
                      _field(_plate, 'Number plate (UBA 123X)',
                          cap: TextCapitalization.characters, validator: (v) => _required(v, 3)),
                      _field(_model, 'Bike model (optional)'),
                      _field(_nationalId, 'National ID number',
                          cap: TextCapitalization.characters, validator: (v) => _required(v, 8)),
                      _field(_permit, 'Driving permit number',
                          cap: TextCapitalization.characters, validator: (v) => _required(v, 4)),
                      _field(_stage, 'Stage name (optional)'),
                    ],
                    if (_error != null)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                      ),
                    FilledButton(
                      onPressed: _busy ? null : _submit,
                      child: _busy
                          ? const SizedBox(
                              height: 22,
                              width: 22,
                              child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                          : Text(_register ? 'Create account' : 'Sign in'),
                    ),
                    TextButton(
                      onPressed: _busy
                          ? null
                          : () => setState(() {
                                _register = !_register;
                                _error = null;
                              }),
                      child: Text(_register ? 'I already have an account' : 'New here? Create an account'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
