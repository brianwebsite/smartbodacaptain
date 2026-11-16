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
    required this.phone,
    required this.status,
    this.bikePlate,
    this.bikeModel,
    this.online = false,
  });

  final String id;
  final String role;
  final String name;
  final String phone;
  final String status;
  final String? bikePlate;
  final String? bikeModel;
  final bool online;

  factory AppUser.fromJson(Map<String, dynamic> j) {
    final cap = j['captain'] as Map<String, dynamic>?;
    return AppUser(
      id: j['id'] as String,
      role: j['role'] as String,
      name: j['name'] as String,
      phone: j['phone'] as String,
      status: j['status'] as String,
      bikePlate: cap?['bikePlate'] as String?,
      bikeModel: cap?['bikeModel'] as String?,
      online: (cap?['online'] as bool?) ?? false,
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
    this.lat,
    this.lng,
  });

  final String id;
  final String name;
  final String phone;
  final String bikePlate;
  final String? bikeModel;
  final double? lat;
  final double? lng;

  factory CaptainInfo.fromJson(Map<String, dynamic> j) {
    final loc = j['location'] as Map<String, dynamic>?;
    return CaptainInfo(
      id: j['id'] as String,
      name: j['name'] as String,
      phone: j['phone'] as String,
      bikePlate: j['bikePlate'] as String,
      bikeModel: j['bikeModel'] as String?,
      lat: (loc?['lat'] as num?)?.toDouble(),
      lng: (loc?['lng'] as num?)?.toDouble(),
    );
  }
}

class PassengerInfo {
  const PassengerInfo({required this.name, required this.phone});

  final String name;
  final String phone;

  factory PassengerInfo.fromJson(Map<String, dynamic> j) =>
      PassengerInfo(name: j['name'] as String, phone: j['phone'] as String);
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
    this.captain,
    this.passenger,
    this.commission,
    this.captainEarnings,
    this.rating,
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
  final CaptainInfo? captain;
  final PassengerInfo? passenger;
  final int? commission;
  final int? captainEarnings;
  final int? rating;

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
        captain: j['captain'] == null
            ? null
            : CaptainInfo.fromJson(j['captain'] as Map<String, dynamic>),
        passenger: j['passenger'] == null
            ? null
            : PassengerInfo.fromJson(j['passenger'] as Map<String, dynamic>),
        commission: (j['commission'] as num?)?.toInt(),
        captainEarnings: (j['captainEarnings'] as num?)?.toInt(),
        rating: (j['rating'] as num?)?.toInt(),
      );
}

class FareEstimate {
  const FareEstimate({
    required this.distanceKm,
    required this.durationMin,
    required this.fare,
    required this.source,
  });

  final double distanceKm;
  final int durationMin;
  final int fare;
  final String source;

  bool get isEstimate => source == 'estimate';

  factory FareEstimate.fromJson(Map<String, dynamic> j) => FareEstimate(
        distanceKm: (j['distanceKm'] as num).toDouble(),
        durationMin: (j['durationMin'] as num).toInt(),
        fare: (j['fare'] as num).toInt(),
        source: j['source'] as String,
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
    required this.commissionOwed,
    required this.byDay,
  });

  final int days;
  final int trips;
  final int gross;
  final int commission;
  final int net;
  final int commissionOwed;
  final List<DayEarning> byDay;

  factory Earnings.fromJson(Map<String, dynamic> j) {
    final t = j['totals'] as Map<String, dynamic>;
    return Earnings(
      days: (j['days'] as num).toInt(),
      trips: (t['trips'] as num).toInt(),
      gross: (t['gross'] as num).toInt(),
      commission: (t['commission'] as num).toInt(),
      net: (t['net'] as num).toInt(),
      commissionOwed: (j['commissionOwed'] as num).toInt(),
      byDay: (j['byDay'] as List<dynamic>)
          .map((d) => DayEarning.fromJson(d as Map<String, dynamic>))
          .toList(),
    );
  }
}
