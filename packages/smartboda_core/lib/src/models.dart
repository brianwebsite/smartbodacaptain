class Place {
  const Place({required this.lat, required this.lng, this.label});

  final double lat;
  final double lng;
  final String? label;

  factory Place.fromJson(Map<String, dynamic> j) => Place(
        lat: (j['lat'] as num).toDouble(),
        lng: (j['lng'] as num).toDouble(),
        label: j['label'] as String?,
      );

  String get text => (label != null && label!.isNotEmpty)
      ? label!
      : '${lat.toStringAsFixed(4)}, ${lng.toStringAsFixed(4)}';
}

class AppUser {
  const AppUser({
    required this.id,
    required this.role,
    required this.name,
    required this.status,
    this.phone,
    this.email,
    this.bikePlate,
    this.bikeModel,
    this.vehicleType = 'boda',
    this.online = false,
    this.walletBalance = 0,
    this.walletAvailable = 0,
    this.creditFree = 0,
    this.creditReserved = 0,
    this.standing = const Standing(),
  });

  final String id;
  final String role;
  final String name;
  final String? phone;
  final String? email;
  final String status;
  final String? bikePlate;
  final String? bikeModel;
  final String vehicleType;
  final bool online;
  final int walletBalance;
  final int walletAvailable;
  /// Prepaid commission credit (riders): free to use, and set aside for accepted cash trips.
  final int creditFree;
  final int creditReserved;
  final Standing standing;

  /// What to show for contact details: phone, else email.
  String get contact => phone ?? email ?? '';

  factory AppUser.fromJson(Map<String, dynamic> j) {
    final cap = j['captain'] as Map<String, dynamic>?;
    final w = j['wallet'] as Map<String, dynamic>?;
    return AppUser(
      id: j['id'] as String,
      role: j['role'] as String,
      name: j['name'] as String,
      phone: j['phone'] as String?,
      email: j['email'] as String?,
      status: j['status'] as String,
      bikePlate: cap?['bikePlate'] as String?,
      bikeModel: cap?['bikeModel'] as String?,
      vehicleType: (cap?['vehicleType'] as String?) ?? 'boda',
      online: (cap?['online'] as bool?) ?? false,
      walletBalance: (w?['balance'] as num?)?.toInt() ?? 0,
      walletAvailable: (w?['available'] as num?)?.toInt() ?? 0,
      creditFree: ((j['credit'] as Map<String, dynamic>?)?['free'] as num?)?.toInt() ?? 0,
      creditReserved: ((j['credit'] as Map<String, dynamic>?)?['reserved'] as num?)?.toInt() ?? 0,
      standing: Standing.fromJson(j['standing'] as Map<String, dynamic>?),
    );
  }
}

class CaptainInfo {
  const CaptainInfo({
    required this.id,
    required this.name,
    required this.phone,
    required this.bikePlate,
    this.bikeModel,
    this.vehicleType = 'boda',
    this.stageName,
    this.rating,
    this.ratingCount = 0,
    this.completedTrips = 0,
    this.memberSince,
    this.lat,
    this.lng,
  });

  final String id;
  final String name;
  final String phone;
  final String bikePlate;
  final String? bikeModel;
  final String vehicleType;
  final String? stageName;
  final double? rating;
  final int ratingCount;
  final int completedTrips;
  final DateTime? memberSince;
  final double? lat;
  final double? lng;

  factory CaptainInfo.fromJson(Map<String, dynamic> j) {
    final loc = j['location'] as Map<String, dynamic>?;
    final since = j['memberSince'] as String?;
    return CaptainInfo(
      id: j['id'] as String,
      name: j['name'] as String,
      phone: j['phone'] as String,
      bikePlate: j['bikePlate'] as String,
      bikeModel: j['bikeModel'] as String?,
      vehicleType: (j['vehicleType'] as String?) ?? 'boda',
      stageName: j['stageName'] as String?,
      rating: (j['rating'] as num?)?.toDouble(),
      ratingCount: (j['ratingCount'] as num?)?.toInt() ?? 0,
      completedTrips: (j['completedTrips'] as num?)?.toInt() ?? 0,
      memberSince: since == null ? null : DateTime.tryParse(since),
      lat: (loc?['lat'] as num?)?.toDouble(),
      lng: (loc?['lng'] as num?)?.toDouble(),
    );
  }
}

class PassengerInfo {
  const PassengerInfo({required this.name, this.phone, this.rating, this.ratingCount = 0});

  final String name;
  final String? phone;
  final double? rating;
  final int ratingCount;

  factory PassengerInfo.fromJson(Map<String, dynamic> j) => PassengerInfo(
        name: j['name'] as String,
        phone: j['phone'] as String?,
        rating: (j['rating'] as num?)?.toDouble(),
        ratingCount: (j['ratingCount'] as num?)?.toInt() ?? 0,
      );
}

class Trip {
  const Trip({
    required this.id,
    required this.status,
    required this.pickup,
    required this.dropoff,
    required this.distanceKm,
    required this.durationMin,
    required this.fare,
    required this.routeSource,
    required this.paymentMethod,
    required this.createdAt,
    this.vehicleType = 'boda',
    this.cancelReason,
    this.cancelledBy,
    this.unread = 0,
    this.captain,
    this.passenger,
    this.commission,
    this.captainEarnings,
    this.rating,
    this.kind = 'ride',
    this.deliveryItem,
    this.receiverName,
    this.receiverPhone,
    this.nightPercent = 0,
    this.autoStarted = false,
    this.passengerRating,
    this.pickupPin,
  });

  final String id;
  final String status;
  final Place pickup;
  final Place dropoff;
  final double distanceKm;
  final int durationMin;
  final int fare;
  final String routeSource;
  final String paymentMethod;
  final DateTime createdAt;
  final String vehicleType;
  final String? cancelReason;
  final String? cancelledBy;
  final int unread;
  final CaptainInfo? captain;
  final PassengerInfo? passenger;
  final int? commission;
  final int? captainEarnings;
  final int? rating;
  final String kind;
  final String? deliveryItem;
  final String? receiverName;
  final String? receiverPhone;
  final int nightPercent;
  final bool autoStarted;
  final int? passengerRating;
  final String? pickupPin;

  bool get isDelivery => kind == 'delivery';

  bool get isFinal => status == 'completed' || status == 'cancelled' || status == 'no_captain';

  factory Trip.fromJson(Map<String, dynamic> j) => Trip(
        id: j['id'] as String,
        status: j['status'] as String,
        pickup: Place.fromJson(j['pickup'] as Map<String, dynamic>),
        dropoff: Place.fromJson(j['dropoff'] as Map<String, dynamic>),
        distanceKm: (j['distanceKm'] as num).toDouble(),
        durationMin: (j['durationMin'] as num).toInt(),
        fare: (j['fare'] as num).toInt(),
        routeSource: j['routeSource'] as String,
        paymentMethod: j['paymentMethod'] as String,
        createdAt: DateTime.parse(j['createdAt'] as String),
        vehicleType: (j['vehicleType'] as String?) ?? 'boda',
        cancelReason: j['cancelReason'] as String?,
        cancelledBy: j['cancelledBy'] as String?,
        unread: (j['unread'] as num?)?.toInt() ?? 0,
        captain: j['captain'] == null
            ? null
            : CaptainInfo.fromJson(j['captain'] as Map<String, dynamic>),
        passenger: j['passenger'] == null
            ? null
            : PassengerInfo.fromJson(j['passenger'] as Map<String, dynamic>),
        commission: (j['commission'] as num?)?.toInt(),
        captainEarnings: (j['captainEarnings'] as num?)?.toInt(),
        rating: (j['rating'] as num?)?.toInt(),
        kind: (j['kind'] as String?) ?? 'ride',
        deliveryItem: j['deliveryItem'] as String?,
        receiverName: j['receiverName'] as String?,
        receiverPhone: j['receiverPhone'] as String?,
        nightPercent: (j['nightPercent'] as num?)?.toInt() ?? 0,
        autoStarted: (j['autoStarted'] as bool?) ?? false,
        passengerRating: (j['passengerRating'] as num?)?.toInt(),
        pickupPin: j['pickupPin'] as String?,
      );
}

class FareOption {
  const FareOption({required this.vehicleType, required this.fare, required this.nearbyCount, this.etaMin});

  final String vehicleType;
  final int fare;
  final int nearbyCount;

  /// Minutes until the nearest free captain of this type could arrive, if any.
  final int? etaMin;

  factory FareOption.fromJson(Map<String, dynamic> j) => FareOption(
        vehicleType: j['vehicleType'] as String,
        fare: (j['fare'] as num).toInt(),
        nearbyCount: (j['nearbyCount'] as num).toInt(),
        etaMin: (j['etaMin'] as num?)?.toInt(),
      );
}

class FareEstimate {
  const FareEstimate({
    required this.distanceKm,
    required this.durationMin,
    required this.source,
    required this.options,
    this.nightPercent = 0,
    this.walletAvailable = 0,
  });

  final int nightPercent;
  final int walletAvailable;
  final double distanceKm;
  final int durationMin;
  final String source;
  final List<FareOption> options;

  bool get isEstimate => source == 'estimate';

  FareOption? option(String vehicleType) {
    for (final o in options) {
      if (o.vehicleType == vehicleType) return o;
    }
    return null;
  }

  factory FareEstimate.fromJson(Map<String, dynamic> j) => FareEstimate(
        distanceKm: (j['distanceKm'] as num).toDouble(),
        durationMin: (j['durationMin'] as num).toInt(),
        source: j['source'] as String,
        nightPercent: (j['nightPercent'] as num?)?.toInt() ?? 0,
        walletAvailable: ((j['wallet'] as Map<String, dynamic>?)?['available'] as num?)?.toInt() ?? 0,
        options: (j['options'] as List<dynamic>)
            .map((o) => FareOption.fromJson(o as Map<String, dynamic>))
            .toList(),
      );
}

class NearbyDriver {
  const NearbyDriver({
    required this.id,
    required this.vehicleType,
    required this.lat,
    required this.lng,
    required this.etaMin,
  });

  final String id;
  final String vehicleType;
  final double lat;
  final double lng;
  final int etaMin;

  factory NearbyDriver.fromJson(Map<String, dynamic> j) => NearbyDriver(
        id: j['id'] as String,
        vehicleType: j['vehicleType'] as String,
        lat: (j['lat'] as num).toDouble(),
        lng: (j['lng'] as num).toDouble(),
        etaMin: (j['etaMin'] as num).toInt(),
      );
}

/// A search result for a destination.
class PlaceSuggestion {
  const PlaceSuggestion({required this.label, required this.title, required this.subtitle, required this.lat, required this.lng});

  final String label;
  final String title;
  final String subtitle;
  final double lat;
  final double lng;

  Place toPlace() => Place(lat: lat, lng: lng, label: label);

  factory PlaceSuggestion.fromJson(Map<String, dynamic> j) => PlaceSuggestion(
        label: j['label'] as String,
        title: j['title'] as String,
        subtitle: (j['subtitle'] as String?) ?? '',
        lat: (j['lat'] as num).toDouble(),
        lng: (j['lng'] as num).toDouble(),
      );
}

class ChatMessage {
  const ChatMessage({required this.id, required this.mine, required this.body, required this.createdAt});

  final String id;
  final bool mine;
  final String body;
  final DateTime createdAt;

  factory ChatMessage.fromJson(Map<String, dynamic> j) => ChatMessage(
        id: j['id'] as String,
        mine: j['mine'] as bool,
        body: j['body'] as String,
        createdAt: DateTime.parse(j['createdAt'] as String),
      );
}

class Offer {
  const Offer({required this.trip, required this.distanceToPickupKm, required this.expiresAt});

  final Trip trip;
  final double distanceToPickupKm;
  final DateTime expiresAt;

  factory Offer.fromJson(Map<String, dynamic> j) => Offer(
        trip: Trip.fromJson(j['trip'] as Map<String, dynamic>),
        distanceToPickupKm: (j['distanceToPickupKm'] as num).toDouble(),
        expiresAt: DateTime.parse(j['expiresAt'] as String),
      );
}

class DayEarning {
  const DayEarning({required this.day, required this.trips, required this.gross, required this.net});

  final String day;
  final int trips;
  final int gross;
  final int net;

  factory DayEarning.fromJson(Map<String, dynamic> j) => DayEarning(
        day: j['day'] as String,
        trips: (j['trips'] as num).toInt(),
        gross: (j['gross'] as num).toInt(),
        net: (j['net'] as num).toInt(),
      );
}

class Earnings {
  const Earnings({
    required this.days,
    required this.trips,
    required this.gross,
    required this.commission,
    required this.net,
    required this.byDay,
    this.creditFree = 0,
    this.creditReserved = 0,
    this.walletBalance = 0,
    this.standing = const Standing(),
  });

  final int creditFree;
  final int creditReserved;
  final int walletBalance;
  final Standing standing;
  final int days;
  final int trips;
  final int gross;
  final int commission;
  final int net;
  final List<DayEarning> byDay;

  factory Earnings.fromJson(Map<String, dynamic> j) {
    final t = j['totals'] as Map<String, dynamic>;
    return Earnings(
      days: (j['days'] as num).toInt(),
      trips: (t['trips'] as num).toInt(),
      gross: (t['gross'] as num).toInt(),
      commission: (t['commission'] as num).toInt(),
      net: (t['net'] as num).toInt(),
      creditFree: ((j['credit'] as Map<String, dynamic>?)?['free'] as num?)?.toInt() ?? 0,
      creditReserved: ((j['credit'] as Map<String, dynamic>?)?['reserved'] as num?)?.toInt() ?? 0,
      walletBalance: (j['walletBalance'] as num?)?.toInt() ?? 0,
      standing: Standing.fromJson(j['standing'] as Map<String, dynamic>?),
      byDay: (j['byDay'] as List<dynamic>)
          .map((d) => DayEarning.fromJson(d as Map<String, dynamic>))
          .toList(),
    );
  }
}

/// How the person stands on Smart Boda's fair-play rules.
class Standing {
  const Standing({this.level = 'ok', this.cancels = 0, this.message});

  /// ok, warning, slowed, paused (captains) or blocked (passengers).
  final String level;
  final int cancels;
  final String? message;

  bool get isOk => level == 'ok';

  factory Standing.fromJson(Map<String, dynamic>? j) => j == null
      ? const Standing()
      : Standing(
          level: (j['level'] as String?) ?? 'ok',
          cancels: (j['cancels'] as num?)?.toInt() ?? 0,
          message: j['message'] as String?,
        );
}

class WalletEntry {
  const WalletEntry({required this.amount, required this.kind, required this.createdAt, this.account = 'wallet', this.note});

  final int amount;
  final String kind;

  /// wallet (passenger), credit (rider commission credit) or earnings (rider digital earnings).
  final String account;
  final String? note;
  final DateTime createdAt;

  String get label {
    switch (kind) {
      case 'wallet_topup':
        return 'Money added';
      case 'credit_topup':
        return 'Commission credit added';
      case 'commission_charged':
        return 'Smart Boda commission for a cash trip';
      case 'commission_reserved':
        return 'Set aside for a cash trip';
      case 'commission_released':
        return 'Returned: the trip did not finish';
      case 'digital_trip':
        return account == 'wallet' ? 'Paid for a trip' : 'Earned from a trip paid in the app';
      case 'manual_payout':
        return 'Paid out to you';
      case 'admin_credit':
        return 'Money added by Smart Boda';
      case 'admin_debit':
        return 'Taken back by Smart Boda';
      case 'trip_payment':
        return 'Paid for a trip';
      case 'trip_earning':
        return 'Earned from a trip';
      case 'commission_netted':
        return 'Smart Boda fee from earlier cash trips';
      case 'payout':
        return 'Paid out to you';
      default:
        return kind;
    }
  }

  factory WalletEntry.fromJson(Map<String, dynamic> j) => WalletEntry(
        amount: (j['amount'] as num).toInt(),
        kind: j['kind'] as String,
        account: (j['account'] as String?) ?? 'wallet',
        note: j['note'] as String?,
        createdAt: DateTime.parse(j['createdAt'] as String),
      );
}

class WalletInfo {
  const WalletInfo({
    required this.balance,
    required this.held,
    required this.available,
    required this.entries,
    required this.topupAvailable,
    this.creditFree,
    this.creditReserved,
    this.pendingWithdrawals = 0,
  });

  final int? creditFree;
  final int? creditReserved;
  final int pendingWithdrawals;
  final int balance;
  final int held;
  final int available;
  final List<WalletEntry> entries;
  final bool topupAvailable;

  factory WalletInfo.fromJson(Map<String, dynamic> j) => WalletInfo(
        balance: (j['balance'] as num).toInt(),
        held: (j['held'] as num).toInt(),
        available: (j['available'] as num).toInt(),
        topupAvailable: (j['topupAvailable'] as bool?) ?? false,
        creditFree: ((j['credit'] as Map<String, dynamic>?)?['free'] as num?)?.toInt(),
        creditReserved: ((j['credit'] as Map<String, dynamic>?)?['reserved'] as num?)?.toInt(),
        pendingWithdrawals: (j['pendingWithdrawals'] as num?)?.toInt() ?? 0,
        entries: (j['entries'] as List<dynamic>)
            .map((e) => WalletEntry.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}
