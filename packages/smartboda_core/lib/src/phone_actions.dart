import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

/// Opens the phone's dialer with the number filled in. The person presses call.
Future<void> callPhone(BuildContext context, String phone) async {
  var opened = false;
  try {
    opened = await launchUrl(Uri(scheme: 'tel', path: phone));
  } catch (_) {
    opened = false;
  }
  if (!opened && context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Could not open the phone app. The number is $phone')),
    );
  }
}
