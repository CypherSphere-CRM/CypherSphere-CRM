import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import Stripe from 'stripe';
import { trialDeadline } from '../lib/access.js';
import { subscriptionAccess } from '../lib/paid.js';

const day = 86400000;
const owner = 'zXrKfpgUoiMq3ySzf8f6a0S25Kv2';

async function remind(doc, stripe) {
  const billing = doc.data();
  if (doc.id === owner || billing.deleting || billing.trialReminderSentAt) return;
  let user;
  try {
    user = await getAuth().getUser(doc.id);
  } catch (error) {
    if (error.code === 'auth/user-not-found') return;
    throw error;
  }
  const end = trialDeadline(user.metadata.creationTime);
  const remaining = end - Date.now();
  if (!user.email || user.disabled || remaining <= 0 || remaining > 3 * day) return;
  const access = await subscriptionAccess(stripe, billing.customer, process.env.STRIPE_PRICE_ID);
  if (access.subscribed || access.paidUntil > Date.now()) return;

  const date = new Date(end).toLocaleDateString('en-US', {dateStyle: 'long', timeZone: 'UTC'});
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'trial-reminder-' + doc.id + '-' + end
    },
    body: JSON.stringify({
      from: 'HackTheRoad <reminders@updates.cyphersphereconsulting.com>',
      to: [user.email],
      subject: 'Your HackTheRoad trial ends ' + date,
      text: 'Your free trial ends on ' + date + ' (UTC). To keep adding loads and expenses, you can subscribe for $4.99 per month. If you subscribe now, billing starts today. If you let the trial expire, you can still view your records.\n\nOpen your driver dashboard: https://hacktheroad.cyphersphereconsulting.com/'
    })
  });
  if (!response.ok) throw new Error('Resend returned ' + response.status);
  await doc.ref.update({trialReminderSentAt: Timestamp.now()});
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' || process.env.VERCEL_ENV !== 'production') return res.status(404).end();
  if (!process.env.CRON_SECRET || req.headers.authorization !== 'Bearer ' + process.env.CRON_SECRET) return res.status(401).end();
  if (!process.env.RESEND_API_KEY || !process.env.STRIPE_PRICE_ID) return res.status(503).end();
  const credential = JSON.parse(process.env.FIREBASE_ADMIN_JSON);
  if (credential.project_id !== 'cyphersphere-ai-crm') return res.status(503).end();
  if (!getApps().length) initializeApp({credential: cert(credential)});
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const now = Date.now();
  const docs = await getFirestore().collection('billing')
    .where('writeUntil', '>', Timestamp.fromMillis(now))
    .where('writeUntil', '<=', Timestamp.fromMillis(now + 3 * day)).get();
  let failures = 0;
  for (const doc of docs.docs) {
    try { await remind(doc, stripe); }
    catch (error) { failures++; console.error('Trial reminder failed', error.code || error.message); }
  }
  return res.status(failures ? 503 : 200).json({checked: docs.size, failures});
}
