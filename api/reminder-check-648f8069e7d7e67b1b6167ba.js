export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if(req.method !== 'GET' || process.env.VERCEL_ENV !== 'production' || Date.now() > 1794839920856) return res.status(404).end();
  const response = await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{ Authorization:'Bearer '+process.env.RESEND_API_KEY, 'Content-Type':'application/json', 'Idempotency-Key':'htr-reminder-check-648f8069e7d7e67b1b6167ba' },
    body:JSON.stringify({from:'HackTheRoad <reminders@updates.cyphersphereconsulting.com>',to:['a.lopez@cyphersphereconsulting.com'],subject:'[Test] Your HackTheRoad trial ends in 3 days',text:'This is a test of the HackTheRoad trial reminder.\n\nYour free trial ends in 3 days. To keep adding loads and expenses, subscribe for $4.99 per month. If you subscribe now, billing starts today. If you let your trial expire, you can still view your records.\n\nOpen your driver dashboard: https://hacktheroad.cyphersphereconsulting.com/'})
  });
  const result=await response.json();
  return res.status(response.status).json(response.ok?{accepted:!!result.id,id:result.id}:{error:result.name,message:result.message});
}