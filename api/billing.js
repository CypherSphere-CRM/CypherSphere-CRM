import {subscriptionAccess} from '../lib/paid.js';
import {getApps, initializeApp, cert} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {getFirestore,Timestamp} from 'firebase-admin/firestore';
import Stripe from 'stripe';
import {trialDeadline,accessMode} from '../lib/access.js';

export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if(process.env.VERCEL_ENV !== 'production') return res.status(404).end();
  if(req.method !== 'POST') return res.status(405).end();
  const key=process.env.STRIPE_SECRET_KEY || '';
  const price=process.env.STRIPE_PRICE_ID;
  if(!process.env.FIREBASE_ADMIN_JSON || !price || !/^[rs]k_live_/.test(key))
    return res.status(503).json({error:'Live billing setup is incomplete.'});
  try {
    const credential=JSON.parse(process.env.FIREBASE_ADMIN_JSON);
    if(credential.project_id !== 'cyphersphere-ai-crm') throw Error('project');
    if(!getApps().length) initializeApp({credential:cert(credential)});
    const auth=getAuth();
    let token;
    try {token=await auth.verifyIdToken((req.headers.authorization||'').replace(/^Bearer /,''),true);}
    catch {return res.status(401).json({error:'Sign in again.'});}
    const action=req.body?.action;
    if(!['status','subscribe','portal','delete-account'].includes(action)) return res.status(400).end();
    const account=await auth.getUser(token.uid);
    const stripe=new Stripe(key);
    const db=getFirestore();
    const ref=db.collection('billing').doc(token.uid);
    if(action==='delete-account'){
      if(token.uid==='zXrKfpgUoiMq3ySzf8f6a0S25Kv2') return res.status(403).json({error:'Owner account deletion is unavailable here.'});
      if(Date.now()/1000-token.auth_time>300) return res.status(401).json({error:'Sign in again to confirm deletion.'});
      const customer=await db.runTransaction(async tx=>{
        const saved=(await tx.get(ref)).data()||{};
        tx.set(ref,{deleting:true,writeUntil:Timestamp.fromMillis(0)},{merge:true});
        return saved.customer;
      });
      if(customer){
        const entry=await stripe.customers.retrieve(customer);
        if(!entry.deleted){
          if(entry.metadata.uid!==token.uid) throw Error('Customer ownership mismatch');
          await stripe.customers.del(customer);
        }
      }
      for(const collection of ['previewBilling','previewDrivers','drivers','driverDirectory']){
        await db.recursiveDelete(db.collection(collection).doc(token.uid));
      }
      await ref.delete();
      await auth.deleteUser(token.uid);
      return res.status(200).json({deleted:true});
    }
    const origin='https://hacktheroad.cyphersphereconsulting.com';
    const result=await db.runTransaction(async tx=>{
      const saved=(await tx.get(ref)).data()||{};
      if(saved.deleting) throw Error('Account deletion in progress');
      const trialEnds = trialDeadline(account.metadata.creationTime);
      let customer=saved.customer;
      if(!customer && action==='subscribe'){
        customer=(await stripe.customers.create({email:account.email,metadata:{uid:token.uid}},
          {idempotencyKey:'htr-live-customer-'+token.uid})).id;
      }
      const {paidUntil,subscribed}=await subscriptionAccess(stripe,customer,price);
      const mode=accessMode(Date.now(),trialEnds,paidUntil);
      const output={mode,trialEnds,paidUntil,hasCustomer:!!customer};
      const record={customer:customer||null,writeUntil:Timestamp.fromMillis(Math.max(trialEnds,paidUntil))};
      if(action==='portal'||(action==='subscribe'&&subscribed)){
        if(!customer) throw Error('missing customer');
        output.url=(await stripe.billingPortal.sessions.create({customer,return_url:origin})).url;
      }else if(action==='subscribe'){
        const p=await stripe.prices.retrieve(price);
        if(!p.livemode||!p.active||p.currency!=='usd'||p.unit_amount!==499||p.recurring?.interval!=='month'||p.recurring.interval_count!==1) throw Error('price');
        let session=saved.session && await stripe.checkout.sessions.retrieve(saved.session);
        if(!session||session.status!=='open'){
          session=await stripe.checkout.sessions.create({mode:'subscription',customer,client_reference_id:token.uid,
            line_items:[{price,quantity:1}],success_url:origin+'/?billing=return',cancel_url:origin+'/'},
            {idempotencyKey:'htr-live-checkout-'+token.uid+'-'+(saved.session||'first')});
        }
        record.session=session.id;
        output.url=session.url;
      }
      tx.set(ref,record,{merge:true});
      return output;
    });
    return res.status(200).json(result);
  } catch(error){
    console.error('Live billing request failed',error.code||error.type||error.name);
    return res.status(503).json({error:'Could not verify billing. Please retry.'});
  }
}
