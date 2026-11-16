// Uganda phone numbers. Everything inside the system uses +256XXXXXXXXX.

/**
 * Accepts 0772123456, 256772123456, +256772123456 (spaces, dashes and
 * brackets allowed) and returns +256772123456. Throws if it is not a
 * 9-digit Ugandan mobile number starting with 7.
 */
export function normalizeUgPhone(input) {
  if (typeof input !== 'string') throw new TypeError('phone must be a string');
  const digits = input.replace(/[\s\-()]/g, '');
  let national;
  if (/^\+256\d{9}$/.test(digits)) national = digits.slice(4);
  else if (/^256\d{9}$/.test(digits)) national = digits.slice(3);
  else if (/^0\d{9}$/.test(digits)) national = digits.slice(1);
  else throw new RangeError('not a valid Uganda phone number');
  if (!national.startsWith('7')) throw new RangeError('not a Uganda mobile number');
  return `+256${national}`;
}
