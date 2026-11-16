import Stripe from 'stripe';
import {getApps,initializeApp,cert} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {getFirestore,Timestamp} from 'firebase-admin/firestore';
import {subscriptionAccess} from '../lib/paid.js';
import {trialDeadline} from '../lib/access.js';
export const config={api:{bodyParser:false}};
export default async function handler(req,res){
  if(process.env.VERCEL_ENV!=='production'||req.method!=='POST') return res.status(404).end();
  const key=process.env.STRIPE_SECRET_KEY||'';
  if(!/^[rs]k_live_/.test(key)||!process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).end();
  const stripe=new Stripe(key);
  let event;
  try{
    const chunks=[];
    for await(const chunk of req) chunks.push(Buffer.from(chunk));
    event=stripe.webhooks.constructEvent(Buffer.concat(chunks),req.headers['stripe-signature'],process.env.STRIPE_WEBHOOK_SECRET);
  }catch{return res.status(400).end();}
  if(!event.livemode) return res.status(400).end();
  if(!event.type.startsWith('customer.subscription.') && !['invoice.paid','invoice.payment_failed','checkout.session.completed'].includes(event.type)) return res.status(200).end();
  try{
    const credential=JSON.parse(process.env.FIREBASE_ADMIN_JSON);
    if(credential.project_id!=='cyphersphere-ai-crm') throw Error('project');
    if(!getApps().length) initializeApp({credential:cert(credential)});
    const customer=event.data.object.customer;
    const db=getFirestore();
    const matches=await db.collection('billing').where('customer','==',customer).limit(1).get();
    if(matches.empty) return res.status(200).end();
    const ref=matches.docs[0].ref;
    const account=await getAuth().getUser(ref.id);
    await db.runTransaction(async tx=>{
      const doc=await tx.get(ref);
      if(doc.data()?.deleting || doc.data()?.customer!==customer) return;
      const {paidUntil}=await subscriptionAccess(stripe,customer,process.env.STRIPE_PRICE_ID);
      tx.update(ref,{writeUntil:Timestamp.fromMillis(Math.max(paidUntil,trialDeadline(account.metadata.creationTime)))});
    });
    return res.status(200).end();
  }catch{return res.status(503).end();}
}
