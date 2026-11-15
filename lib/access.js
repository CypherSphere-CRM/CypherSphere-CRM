export function trialDeadline(creationTime) {
  return Date.parse(creationTime) + 14 * 86400000;
}
export function accessMode(now, trialEnds, paidUntil) {
  if (now < paidUntil) return 'paid';
  return now < trialEnds ? 'trial' : 'read-only';
}
