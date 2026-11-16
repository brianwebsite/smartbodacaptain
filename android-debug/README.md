# Test signing key (debug only)

`debug.keystore` signs the **test** APKs built by GitHub Actions, so the app's
signing fingerprint stays the same from build to build. Google sign-in needs
that. The password is the Android default (`android`), and anyone with this
file can sign apps that look like your test builds.

Never use it for the Play Store. The store release key is a different file,
created later, kept secret, and never committed.
