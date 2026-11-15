import {subscriptionAccess} from '../lib/paid.js';
import {getApps, initializeApp, cert} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {getFirestore,Timestamp} from 'firebase-admin/firestore';
import Stripe from 'stripe';
import {trialDeadline,accessMode} from '../lib/access.js';

export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if(process.env.VERCEL_ENV !== 'preview') return res.status(404).end();
  if(req.method !== 'POST') return res.status(405).end();
  const key=process.env.STRIPE_SECRET_KEY || '';
  const price=process.env.STRIPE_PRICE_ID;
  if(!process.env.FIREBASE_ADMIN_JSON || !price || !/^[rs]k_test_/.test(key))
    return res.status(503).json({error:'Preview billing setup is incomplete.'});
  try {
    const credential=JSON.parse(process.env.FIREBASE_ADMIN_JSON);
    if(credential.project_id !== 'cyphersphere-ai-crm') throw Error('project');
    if(!getApps().length) initializeApp({credential:cert(credential)});
    const auth=getAuth();
    let token;
    try {token=await auth.verifyIdToken((req.headers.authorization||'').replace(/^Bearer /,''),true);}
    catch {return res.status(401).json({error:'Sign in again.'});}
    const action=req.body?.action;
    if(!['status','subscribe','portal'].includes(action)) return res.status(400).end();
    const account=await auth.getUser(token.uid);
    const stripe=new Stripe(key);
    const db=getFirestore();
    const ref=db.collection('previewBilling').doc(token.uid);
    const trialEnds=trialDeadline(account.metadata.creationTime);
    const origin='https://'+process.env.VERCEL_URL;
    const result=await db.runTransaction(async tx=>{
      const saved=(await tx.get(ref)).data()||{};
      let customer=saved.customer;
      if(!customer && action==='subscribe'){
        customer=(await stripe.customers.create({email:account.email,metadata:{uid:token.uid}},
          {idempotencyKey:'htr-preview-customer-'+token.uid})).id;
      }
      const {paidUntil,subscribed}=await subscriptionAccess(stripe,customer,price);
      const mode=accessMode(Date.now(),trialEnds,paidUntil);
      const output={mode,trialEnds,paidUntil,hasCustomer:!!customer};
      const record={customer:customer||null,writeUntil:Timestamp.fromMillis(Math.max(trialEnds,paidUntil))};
      if(action==='portal'||(action==='subscribe'&&subscribed)){
        if(!customer) throw Error('missing customer');
        output.url=(await stripe.billingPortal.sessions.create({customer,return_url:origin})).url;
      }else if(action==='subscribe'){
        if(Date.now()<trialEnds) return {...output,error:'Your free trial is still active.'};
        const p=await stripe.prices.retrieve(price);
        if(p.livemode||!p.active||p.currency!=='usd'||p.unit_amount!==499||p.recurring?.interval!=='month'||p.recurring.interval_count!==1) throw Error('price');
        let session=saved.session && await stripe.checkout.sessions.retrieve(saved.session);
        if(!session||session.status!=='open'){
          session=await stripe.checkout.sessions.create({mode:'subscription',customer,client_reference_id:token.uid,
            line_items:[{price,quantity:1}],success_url:origin+'/?billing=return',cancel_url:origin+'/'},
            {idempotencyKey:'htr-preview-checkout-'+token.uid+'-'+(saved.session||'first')});
        }
        record.session=session.id;
        output.url=session.url;
      }
      tx.set(ref,record,{merge:true});
      return output;
    });
    return res.status(200).json(result);
  } catch(error){
    console.error('Preview billing request failed',error.code||error.type||error.name);
    return res.status(503).json({error:'Could not verify billing. Please retry.'});
  }
}
