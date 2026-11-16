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
      builder: (context, _) => AccountMenu(session: widget.session, isCaptain: true),
    );
  }
}
