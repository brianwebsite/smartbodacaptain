import 'package:flutter/material.dart';
import 'package:google_sign_in/google_sign_in.dart';

import 'api.dart';
import 'forgot_password_screen.dart';
import 'session.dart';
import 'theme.dart';
import 'vehicle.dart';

enum _Stage { welcome, method, questions, login }

enum _Mode { signUp, signIn }

enum _Method { google, email, phone }

/// One thing to ask on one screen.
class _Q {
  const _Q({
    required this.id,
    required this.title,
    required this.label,
    this.hint,
    this.type,
    this.secret = false,
    this.optional = false,
    this.cap = TextCapitalization.none,
    this.minLength = 1,
    this.isEmail = false,
    this.choices,
  });

  final String id;
  final String title;
  final String label;
  final String? hint;
  final TextInputType? type;
  final bool secret;
  final bool optional;
  final TextCapitalization cap;
  final int minLength;
  final bool isEmail;

  /// When set, the question is answered by tapping one of these instead of typing.
  final List<VehicleType>? choices;

  String? check(String value) {
    final v = value.trim();
    if (v.isEmpty) return optional ? null : (choices != null ? 'Please pick one to continue' : 'Please answer this to continue');
    if (isEmail && !RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]{2,}$').hasMatch(v)) {
      return 'That does not look like an email address';
    }
    if (v.length < minLength && !secret) return 'That looks too short';
    if (secret && value.length < minLength) return 'Use at least $minLength characters';
    return null;
  }
}

/// Welcome, then one question at a time until the person is signed in.
class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key, required this.session, required this.appTitle});

  final Session session;
  final String appTitle;

  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  _Stage _stage = _Stage.welcome;
  _Mode _mode = _Mode.signUp;
  _Method _method = _Method.phone;

  List<_Q> _questions = const [];
  int _index = 0;
  final Map<String, TextEditingController> _controllers = {};
  bool _hideSecret = true;
  bool _busy = false;
  String? _error;

  String? _googleClientId;
  String? _googleIdToken;

  /// True when this phone has had an account before: then "Sign in" is the main button.
  bool _returning = false;

  /// False until we know whether this phone has had an account (avoids a flash of the wrong screen).
  bool _checked = false;

  bool get _isCaptain => widget.session.role == 'captain';
  bool get _googleAvailable => !_isCaptain && _googleClientId != null;

  @override
  void initState() {
    super.initState();
    Session.hasSignedInBefore().then((v) {
      if (!mounted) return;
      setState(() {
        _checked = true;
        if (v) {
          // Someone who already has an account only needs to log in.
          _returning = true;
          _mode = _Mode.signIn;
          _stage = _Stage.login;
        }
      });
    });
    if (!_isCaptain) {
      widget.session.googleServerClientId().then((id) {
        if (mounted) setState(() => _googleClientId = id);
      });
    }
  }

  @override
  void dispose() {
    for (final c in _controllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  TextEditingController _controller(String id) =>
      _controllers.putIfAbsent(id, () => TextEditingController());

  String _answer(String id) => _controller(id).text.trim();

  // ---------- the questions for each path ----------

  _Q _nameQ() => const _Q(
        id: 'name',
        title: 'What is your name?',
        hint: 'Your first and last name.',
        label: 'Full name',
        cap: TextCapitalization.words,
        minLength: 2,
      );

  _Q _phoneQ(String id, {String? title, String? hint}) => _Q(
        id: id,
        title: title ?? 'What is your phone number?',
        hint: hint,
        label: 'Phone number (0772 123456)',
        type: TextInputType.phone,
        minLength: 9,
      );

  _Q _emailQ(String id, {String? title}) => _Q(
        id: id,
        title: title ?? 'What is your email address?',
        label: 'Email',
        type: TextInputType.emailAddress,
        isEmail: true,
      );

  List<_Q> _buildQuestions() {
    if (_mode == _Mode.signIn) {
      return [
        _method == _Method.email ? _emailQ('identifier') : _phoneQ('identifier'),
        const _Q(id: 'password', title: 'Enter your password', label: 'Password', secret: true, minLength: 1),
      ];
    }
    if (_method == _Method.google) {
      return [_nameQ()];
    }
    final phoneQ = _phoneQ('phone',
        hint: _isCaptain
            ? 'Passengers and Smart Boda use it to reach you.'
            : 'Captains use it to reach you about your ride.');
    return [
      if (_method == _Method.email) ...[
        _emailQ('email', title: 'What is your email address?'),
        _nameQ(),
        // Passengers need only an email and a password. Captains also need a phone number.
        if (_isCaptain) phoneQ,
      ] else ...[
        _phoneQ('phone', title: 'What is your phone number?', hint: 'We will use it to sign you in.'),
        _nameQ(),
      ],
      const _Q(
        id: 'password',
        title: 'Choose a password',
        hint: 'At least 6 characters. You will use it to sign in.',
        label: 'Password',
        secret: true,
        minLength: 6,
      ),
      if (_isCaptain) ..._captainQuestions(),
    ];
  }

  List<_Q> _captainQuestions() => const [
        _Q(
          id: 'vehicleType',
          title: 'What will you drive?',
          hint: 'Passengers choose a type when they ask for a ride.',
          label: 'Vehicle',
          choices: vehicleTypes,
        ),
        _Q(
          id: 'bikePlate',
          title: 'What is your number plate?',
          label: 'Number plate (UBA 123X)',
          cap: TextCapitalization.characters,
          minLength: 3,
        ),
        _Q(
          id: 'bikeModel',
          title: 'What make and model is it?',
          hint: 'For example Bajaj Boxer or Toyota Premio. You can skip this.',
          label: 'Make and model',
          optional: true,
        ),
        _Q(
          id: 'nationalId',
          title: 'What is your National ID number?',
          hint: 'We check it before you can take trips.',
          label: 'National ID number',
          cap: TextCapitalization.characters,
          minLength: 8,
        ),
        _Q(
          id: 'permitNumber',
          title: 'What is your driving permit number?',
          label: 'Driving permit number',
          cap: TextCapitalization.characters,
          minLength: 4,
        ),
        _Q(
          id: 'stageName',
          title: 'Which stage do you work from?',
          hint: 'You can skip this.',
          label: 'Stage name',
          optional: true,
        ),
      ];

  // ---------- navigation ----------

  void _go(_Mode mode) => setState(() {
        _mode = mode;
        _stage = _Stage.method;
        _error = null;
      });

  void _chooseMethod(_Method m) {
    setState(() {
      _method = m;
      _questions = _buildQuestions();
      _index = 0;
      _stage = _Stage.questions;
      _error = null;
    });
  }

  void _back() {
    if (_busy) return;
    setState(() {
      _error = null;
      if (_stage == _Stage.questions) {
        if (_index > 0) {
          _index--;
        } else {
          _stage = _Stage.method;
        }
      } else if (_stage == _Stage.method) {
        _stage = _returning ? _Stage.login : _Stage.welcome;
        if (_returning) _mode = _Mode.signIn;
      } else if (_stage == _Stage.login) {
        _stage = _Stage.welcome;
      }
    });
  }

  // ---------- actions ----------

  Future<void> _next() async {
    final q = _questions[_index];
    final problem = q.check(_controller(q.id).text);
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    setState(() => _error = null);
    if (_index < _questions.length - 1) {
      setState(() => _index++);
      return;
    }
    await _finish();
  }

  Future<void> _finish() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_mode == _Mode.signIn) {
        await widget.session.login(_answer('identifier'), _controller('password').text);
      } else if (_method == _Method.google) {
        await widget.session.googleSignIn(_googleIdToken!, name: _answer('name'));
      } else {
        await widget.session.register({
          'name': _answer('name'),
          if (_answer('phone').isNotEmpty) 'phone': _answer('phone'),
          'password': _controller('password').text,
          if (_method == _Method.email) 'email': _answer('email'),
          if (_isCaptain) ...{
            'vehicleType': _answer('vehicleType'),
            'bikePlate': _answer('bikePlate'),
            'bikeModel': _answer('bikeModel'),
            'nationalId': _answer('nationalId'),
            'permitNumber': _answer('permitNumber'),
            'stageName': _answer('stageName'),
          },
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _forgot() {
    final typed = _answer('identifier');
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => ForgotPasswordScreen(session: widget.session, email: typed.contains('@') ? typed : ''),
    ));
  }

  Future<void> _google() async {
    final clientId = _googleClientId;
    if (clientId == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final gs = GoogleSignIn(scopes: const ['email'], serverClientId: clientId);
      final account = await gs.signIn();
      if (account == null) return; // the person closed the Google window
      final token = (await account.authentication).idToken;
      if (token == null) {
        throw const ApiException('Google did not give us a sign-in. Please try again.');
      }
      final more = await widget.session.googleSignIn(token);
      if (more != null && mounted) {
        // Google gave no name, so ask for one.
        _googleIdToken = token;
        _mode = _Mode.signUp;
        _chooseMethod(_Method.google);
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Google sign-in is not available right now. Use email or phone instead.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // ---------- screens ----------

  @override
  Widget build(BuildContext context) {
    if (!_checked) return const Scaffold(body: SizedBox.shrink());
    return PopScope(
      canPop: _stage == _Stage.welcome || _stage == _Stage.login,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _back();
      },
      child: Scaffold(
        body: SafeArea(
          child: AnimatedSwitcher(
            duration: const Duration(milliseconds: 220),
            child: KeyedSubtree(
              key: ValueKey('${_stage.name}-${_stage == _Stage.questions ? _questions[_index].id : ''}'),
              child: switch (_stage) {
                _Stage.welcome => _welcome(context),
                _Stage.method => _methodScreen(context),
                _Stage.questions => _questionScreen(context),
                _Stage.login => _loginScreen(context),
              },
            ),
          ),
        ),
      ),
    );
  }

  Widget _frame({required Widget child, bool back = true, double? progress}) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 8, 24, 16),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  if (back)
                    IconButton(
                      onPressed: _busy ? null : _back,
                      icon: const Icon(Icons.arrow_back),
                      tooltip: 'Back',
                    )
                  else
                    const SizedBox(height: 48),
                  if (progress != null)
                    Expanded(
                      child: Padding(
                        padding: const EdgeInsets.only(right: 12),
                        child: LinearProgressIndicator(value: progress, minHeight: 6, borderRadius: BorderRadius.circular(3)),
                      ),
                    ),
                ],
              ),
              Expanded(child: child),
            ],
          ),
        ),
      ),
    );
  }

  Widget _welcome(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return _frame(
      back: false,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Spacer(),
          TweenAnimationBuilder<double>(
            tween: Tween(begin: 0.4, end: 1),
            duration: const Duration(milliseconds: 700),
            curve: Curves.elasticOut,
            builder: (context, v, child) => Transform.scale(scale: v, child: child),
            child: Container(
              height: 112,
              width: 112,
              alignment: Alignment.center,
              decoration: const BoxDecoration(
                shape: BoxShape.circle,
                gradient: LinearGradient(colors: [brandPrimary, brandDark], begin: Alignment.topLeft, end: Alignment.bottomRight),
              ),
              child: const Icon(Icons.two_wheeler, size: 64, color: Colors.white),
            ),
          ),
          const SizedBox(height: 16),
          Text('Welcome to\n${widget.appTitle}',
              textAlign: TextAlign.center,
              style: t.headlineLarge?.copyWith(fontWeight: FontWeight.bold, color: brandPrimary)),
          const SizedBox(height: 12),
          Text(
            _isCaptain ? 'Get trip requests and keep your earnings.' : 'Safe, fair boda rides at the tap of a button.',
            textAlign: TextAlign.center,
            style: t.bodyLarge,
          ),
          const Spacer(),
          if (_returning) ...[
            FilledButton(
                onPressed: () => setState(() {
                      _mode = _Mode.signIn;
                      _stage = _Stage.login;
                      _error = null;
                    }),
                child: const Text('Sign in')),
            const SizedBox(height: 12),
            OutlinedButton(onPressed: () => _go(_Mode.signUp), child: const Text('Create a new account')),
          ] else ...[
            FilledButton(onPressed: () => _go(_Mode.signUp), child: const Text('Create an account')),
            const SizedBox(height: 12),
            OutlinedButton(onPressed: () => _go(_Mode.signIn), child: const Text('I already have an account')),
          ],
          const SizedBox(height: 8),
        ],
      ),
    );
  }

  /// For someone who already has an account: one screen, email or phone and password.
  Widget _loginScreen(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final id = _controller('identifier');
    final pw = _controller('password');
    Future<void> submit() async {
      if (id.text.trim().length < 3) {
        setState(() => _error = 'Enter the email or phone number you signed up with.');
        return;
      }
      if (pw.text.isEmpty) {
        setState(() => _error = 'Enter your password.');
        return;
      }
      _mode = _Mode.signIn;
      await _finish();
    }

    return _frame(
      back: false,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: ListView(
              children: [
                const SizedBox(height: 16),
                Center(
                  child: Container(
                    height: 76,
                    width: 76,
                    decoration: const BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: LinearGradient(colors: [brandPrimary, brandDark], begin: Alignment.topLeft, end: Alignment.bottomRight),
                    ),
                    child: const Icon(Icons.two_wheeler, size: 44, color: Colors.white),
                  ),
                ),
                const SizedBox(height: 16),
                Text('Welcome back',
                    textAlign: TextAlign.center, style: t.headlineMedium?.copyWith(fontWeight: FontWeight.w900, color: brandPrimary)),
                const SizedBox(height: 28),
                TextField(
                  controller: id,
                  enabled: !_busy,
                  keyboardType: TextInputType.emailAddress,
                  autocorrect: false,
                  textInputAction: TextInputAction.next,
                  onChanged: (_) => setState(() => _error = null),
                  decoration: const InputDecoration(labelText: 'Email or phone number', prefixIcon: Icon(Icons.person_outline)),
                ),
                const SizedBox(height: 14),
                TextField(
                  controller: pw,
                  enabled: !_busy,
                  obscureText: _hideSecret,
                  autocorrect: false,
                  enableSuggestions: false,
                  textInputAction: TextInputAction.done,
                  onSubmitted: (_) => _busy ? null : submit(),
                  onChanged: (_) => setState(() => _error = null),
                  decoration: InputDecoration(
                    labelText: 'Password',
                    prefixIcon: const Icon(Icons.lock_outline),
                    suffixIcon: IconButton(
                      icon: Icon(_hideSecret ? Icons.visibility : Icons.visibility_off),
                      onPressed: () => setState(() => _hideSecret = !_hideSecret),
                    ),
                  ),
                ),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                  ),
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(onPressed: _busy ? null : _forgot, child: const Text('Forgot password?')),
                ),
                if (_googleAvailable) ...[
                  const SizedBox(height: 8),
                  OutlinedButton.icon(
                    onPressed: _busy ? null : _google,
                    icon: const Icon(Icons.g_mobiledata, size: 32),
                    label: const Text('Continue with Google'),
                  ),
                ],
              ],
            ),
          ),
          FilledButton(
            onPressed: _busy ? null : submit,
            child: _busy
                ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Text('Sign in'),
          ),
          TextButton(
            onPressed: _busy ? null : () => _go(_Mode.signUp),
            child: const Text('New here? Create an account'),
          ),
        ],
      ),
    );
  }

  Widget _methodScreen(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final up = _mode == _Mode.signUp;
    return _frame(
      child: ListView(
        children: [
          const SizedBox(height: 24),
          Text(up ? 'How would you like to sign up?' : 'How would you like to sign in?',
              style: t.headlineSmall?.copyWith(fontWeight: FontWeight.bold)),
          const SizedBox(height: 24),
          if (_googleAvailable) ...[
            OutlinedButton.icon(
              onPressed: _busy ? null : _google,
              icon: const Icon(Icons.g_mobiledata, size: 32),
              label: const Text('Continue with Google'),
            ),
            const SizedBox(height: 12),
          ],
          OutlinedButton.icon(
            onPressed: _busy ? null : () => _chooseMethod(_Method.email),
            icon: const Icon(Icons.email_outlined),
            label: const Text('Use my email'),
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: _busy ? null : () => _chooseMethod(_Method.phone),
            icon: const Icon(Icons.phone_outlined),
            label: const Text('Use my phone number'),
          ),
          if (_busy) const Padding(padding: EdgeInsets.only(top: 24), child: LinearProgressIndicator()),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 16),
              child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ),
        ],
      ),
    );
  }

  Widget _questionScreen(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final q = _questions[_index];
    final last = _index == _questions.length - 1;
    final c = _controller(q.id);
    final action = last ? (_mode == _Mode.signIn ? 'Sign in' : 'Create account') : 'Continue';
    return _frame(
      progress: (_index + 1) / _questions.length,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: ListView(
              children: [
                const SizedBox(height: 24),
                Text(q.title, style: t.headlineSmall?.copyWith(fontWeight: FontWeight.bold)),
                if (q.hint != null) ...[
                  const SizedBox(height: 8),
                  Text(q.hint!, style: t.bodyMedium),
                ],
                const SizedBox(height: 24),
                if (q.choices != null)
                  for (final v in q.choices!)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: InkWell(
                        borderRadius: BorderRadius.circular(14),
                        onTap: _busy
                            ? null
                            : () => setState(() {
                                  c.text = v.id;
                                  _error = null;
                                }),
                        child: Container(
                          padding: const EdgeInsets.all(16),
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(14),
                            border: Border.all(
                              color: c.text == v.id ? brandPrimary : Colors.black26,
                              width: c.text == v.id ? 2.5 : 1,
                            ),
                            color: c.text == v.id ? brandPrimary.withValues(alpha: 0.08) : null,
                          ),
                          child: Row(
                            children: [
                              Icon(v.icon, size: 34, color: v.color),
                              const SizedBox(width: 14),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(v.label, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
                                    Text(v.blurb),
                                  ],
                                ),
                              ),
                              if (c.text == v.id) const Icon(Icons.check_circle, color: brandPrimary),
                            ],
                          ),
                        ),
                      ),
                    )
                else
                TextField(
                  controller: c,
                  autofocus: true,
                  enabled: !_busy,
                  obscureText: q.secret && _hideSecret,
                  keyboardType: q.type,
                  textCapitalization: q.cap,
                  autocorrect: !(q.secret || q.isEmail),
                  enableSuggestions: !q.secret,
                  textInputAction: last ? TextInputAction.done : TextInputAction.next,
                  onSubmitted: (_) => _busy ? null : _next(),
                  onChanged: (_) => setState(() => _error = null),
                  decoration: InputDecoration(
                    labelText: q.label + (q.optional ? ' (optional)' : ''),
                    suffixIcon: q.secret
                        ? IconButton(
                            icon: Icon(_hideSecret ? Icons.visibility : Icons.visibility_off),
                            onPressed: () => setState(() => _hideSecret = !_hideSecret),
                          )
                        : null,
                  ),
                ),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                  ),
                if (_mode == _Mode.signIn && q.id == 'password')
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton(onPressed: _busy ? null : _forgot, child: const Text('Forgot password?')),
                  ),
              ],
            ),
          ),
          FilledButton(
            onPressed: _busy ? null : _next,
            child: _busy
                ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : Text(q.optional && c.text.trim().isEmpty && !last ? 'Skip' : action),
          ),
        ],
      ),
    );
  }
}
