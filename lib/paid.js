export async function subscriptionAccess(stripe,customer,price){
      let paidUntil=0;
      let subscribed=false;
      if(customer){
        const subs=await stripe.subscriptions.list({customer,price,status:'all',limit:100,expand:['data.latest_invoice']});
        for(const sub of subs.data){
          if(['active','past_due','trialing','incomplete','unpaid','paused'].includes(sub.status)) subscribed=true;
          if(sub.status!=='active' || sub.latest_invoice?.status!=='paid' || !(sub.latest_invoice.amount_paid>0)) continue;
          const item=sub.items.data.find(i=>i.price.id===price);
          if(item) paidUntil=Math.max(paidUntil,1000*(item.current_period_end||sub.current_period_end||0));
        }
      }
  return {paidUntil,subscribed};
}
