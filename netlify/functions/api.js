const crypto = require("crypto");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const headers = {"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type, Authorization","Access-Control-Allow-Methods":"GET,POST,OPTIONS"};
function json(status,body){return {statusCode:status,headers,body:JSON.stringify(body)}}
async function sb(path,opts={}){const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{...opts,headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,"Content-Type":"application/json",Prefer:opts.prefer||"return=representation",...(opts.headers||{})}});const text=await r.text();let data;try{data=JSON.parse(text)}catch{data=text}if(!r.ok)throw new Error(typeof data==='string'?data:(data.message||data.error||`Supabase ${r.status}`));return data}
function hash(v){return crypto.createHash("sha256").update(v).digest("hex")}
exports.handler=async(event)=>{
 if(event.httpMethod==='OPTIONS')return {statusCode:204,headers,body:""};
 if(!SUPABASE_URL||!SERVICE_KEY)return json(500,{error:"Supabase environment variables are missing."});
 try{
  const path=(event.path.split('/').pop()||'api').toLowerCase();
  if(path==='init'){
   const body=JSON.parse(event.body||'{}'); if(!body.deviceId)return json(400,{error:"deviceId required"});
   const email=`device_${hash(body.deviceId).slice(0,24)}@proptrack.local`;
   let users=await sb(`users?email=eq.${encodeURIComponent(email)}&select=id`);
   let userId=users[0]?.id;
   if(!userId){let u=await sb('users',{method:'POST',body:JSON.stringify({email,password_hash:hash(body.deviceId+Date.now()+Math.random()),created_at:new Date().toISOString()})});userId=u[0].id}
   const token=crypto.randomBytes(32).toString('hex'); const expires=new Date(Date.now()+1000*60*60*24*365).toISOString();
   await sb('sessions',{method:'POST',body:JSON.stringify({token,user_id:userId,expires_at:expires,created_at:new Date().toISOString()})});
   return json(200,{token});
  }
  const auth=event.headers.authorization||event.headers.Authorization||''; const token=auth.replace(/^Bearer\s+/i,''); if(!token)return json(401,{error:'Missing session'});
  const sessions=await sb(`sessions?token=eq.${encodeURIComponent(token)}&select=user_id,expires_at`); if(!sessions[0]||new Date(sessions[0].expires_at)<new Date())return json(401,{error:'Session expired'}); const userId=sessions[0].user_id;
  if(path==='data'){
    const accounts=await sb(`accounts?user_id=eq.${userId}&select=*`); const ids=accounts.map(a=>a.id);
    let trades=[]; if(ids.length)trades=await sb(`trades?account_id=in.(${ids.join(',')})&select=*`);
    const mapped=accounts.map(x=>({...x,trades:trades.filter(t=>t.account_id===x.id).map(t=>({id:t.id,date:t.created_at,pair:t.pair,side:t.direction,pnl:Number(t.pnl),entry:t.entry,exit:t.exit,size:t.lot,risk:t.notes?null:null,note:t.notes,balanceAfter:Number(t.balance_after)}))}));
    return json(200,{accounts:mapped});
  }
  if(path==='sync'){
    const {accounts=[]}=JSON.parse(event.body||'{}');
    const old=await sb(`accounts?user_id=eq.${userId}&select=id`); const oldIds=new Set(old.map(x=>x.id)); const incomingIds=new Set(accounts.map(x=>x.id));
    for(const x of accounts){const row={id:x.id,user_id:userId,firm:x.firm,name:x.name,account_size:x.accountSize,target_type:x.targetType||'usd',target_input:x.targetInput??x.target,max_dd_type:x.maxDdType||'usd',max_dd_input:x.maxDdInput??x.maxDd,daily_dd_type:x.dailyDdType||'usd',daily_dd_input:x.dailyDdInput??x.dailyDd,created_at:new Date().toISOString()}; if(oldIds.has(x.id))await sb(`accounts?id=eq.${encodeURIComponent(x.id)}&user_id=eq.${userId}`,{method:'PATCH',body:JSON.stringify(row)});else await sb('accounts',{method:'POST',body:JSON.stringify(row)});
      const oldTrades=await sb(`trades?account_id=eq.${encodeURIComponent(x.id)}&select=id`); const oldTradeIds=new Set(oldTrades.map(t=>t.id));
      for(const t of (x.trades||[])){const tr={id:t.id,account_id:x.id,pair:t.pair,direction:t.side,pnl:Number(t.pnl),entry:t.entry,exit:t.exit,lot:t.size,notes:t.note||null,balance_after:Number(t.balanceAfter),created_at:t.date||new Date().toISOString()};if(oldTradeIds.has(t.id))await sb(`trades?id=eq.${encodeURIComponent(t.id)}&account_id=eq.${encodeURIComponent(x.id)}`,{method:'PATCH',body:JSON.stringify(tr)});else await sb('trades',{method:'POST',body:JSON.stringify(tr)});}
    }
    for(const id of oldIds){if(!incomingIds.has(id))await sb(`accounts?id=eq.${encodeURIComponent(id)}&user_id=eq.${userId}`,{method:'DELETE'})}
    return json(200,{ok:true});
  }
  return json(404,{error:'Not found'});
 }catch(e){console.error(e);return json(500,{error:e.message||'Server error'})}
};
