/// 5300 becomes "UGX 5,300".
String ugx(num amount) {
  final s = amount.round().abs().toString();
  final b = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
    b.write(s[i]);
  }
  return '${amount < 0 ? '-' : ''}UGX $b';
}

/// Plain-words label for a trip status.
String statusLabel(String status) {
  switch (status) {
    case 'requested':
      return 'Finding a captain';
    case 'accepted':
      return 'Captain is on the way';
    case 'arrived':
      return 'Captain has arrived';
    case 'in_progress':
      return 'On the trip';
    case 'completed':
      return 'Completed';
    case 'cancelled':
      return 'Cancelled';
    case 'no_captain':
      return 'No captain found';
    default:
      return status;
  }
}

String shortDate(DateTime t) {
  final l = t.toLocal();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  final hh = l.hour.toString().padLeft(2, '0');
  final mm = l.minute.toString().padLeft(2, '0');
  return '${l.day} ${months[l.month - 1]}, $hh:$mm';
}

String monthYear(DateTime t) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  final l = t.toLocal();
  return '${months[l.month - 1]} ${l.year}';
}
