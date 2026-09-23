const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function load(file, deps, env = {}) {
  const ctx = { module: { exports: {} }, require: n => deps[n], process: { env }, console, Date };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), ctx);
  return ctx.module.exports;
}
function response() { return { setHeader(){}, status(n){this.code=n;return this}, json(v){this.body=v;return this} }; }
test('report refuses unauthenticated access before database or Stripe work', async () => {
  const handler = load('api/agent-report.js', {stripe: function(){throw Error('must not call')}, './_lib': {supabase(){throw Error('must not call')}}}, {AGENT_KEY:'secret'});
  for (const query of [{}, {detail:'1'}, {key:'wrong'}]) {
    const res=response(); await handler({method:'GET',query,headers:{}},res); assert.equal(res.code,401);
    assert.equal(res.body.snapshot,undefined);
  }
});
function database(fail) {
  return {from(name){ const result={data:name==='business_snapshot'?{}:[],count:0,error:fail&&name==='orders'?{message:'missing relation'}:null};
    const chain=new Proxy({}, {get(_, prop){if(prop==='then')return (ok)=>Promise.resolve(result).then(ok);return ()=>chain}});return chain; }};
}
for (const fail of [true,false]) test(`report database failure=${fail} remains distinguishable from zero`, async()=>{
 const handler=load('api/agent-report.js',{stripe:function(){},'./_lib':{supabase:()=>database(fail)}},{AGENT_KEY:'secret'});
 const res=response();await handler({method:'GET',headers:{authorization:'Bearer secret'},query:{}},res);
 assert.equal(res.code,fail?503:200);
 if(fail){assert.equal(res.body.orders_7d,undefined);assert.ok(res.body.activity_error);}else assert.equal(res.body.orders_7d.count,0);
});
test('Stripe-only degradation remains available to scheduled consumers', async()=>{
  function Stripe(){
    this.balance={retrieve:async()=>{throw Error('stripe unavailable')}};
    this.payouts={list:async()=>({data:[]})};
    this.disputes={list:async()=>({data:[]})};
    this.charges={list:async()=>({data:[]})};
  }
  const handler=load('api/agent-report.js',{stripe:Stripe,'./_lib':{supabase:()=>database(false)}},{AGENT_KEY:'secret',STRIPE_SECRET_KEY:'test'});
  const res=response();await handler({method:'GET',headers:{authorization:'Bearer secret'},query:{}},res);
  assert.equal(res.code,200);assert.equal(res.body.status,'degraded');assert.ok(res.body.stripe_error);
  assert.equal(res.body.orders_7d.count,0);
});
function databaseWithDetailFailure(){
  let ordersCalls=0; let leadsCalls=0;
  return {from(name){
    if(name==='orders') ordersCalls += 1;
    if(name==='leads') leadsCalls += 1;
    const isDetailFailure=(name==='orders'&&ordersCalls>1)||(name==='leads'&&leadsCalls>1);
    const result={data:name==='business_snapshot'?{}:[],count:0,error:isDetailFailure?{message:'detail unavailable'}:null};
    const chain=new Proxy({}, {get(_, prop){if(prop==='then')return (ok)=>Promise.resolve(result).then(ok);return ()=>chain}});return chain;
  }};
}
test('detail-only degradation does not take aggregate monitors dark', async()=>{
  const handler=load('api/agent-report.js',{stripe:function(){},'./_lib':{supabase:()=>databaseWithDetailFailure()}},{AGENT_KEY:'secret'});
  const res=response();await handler({method:'GET',headers:{authorization:'Bearer secret'},query:{detail:'1'}},res);
  assert.equal(res.code,200);assert.equal(res.body.status,'degraded');assert.ok(res.body.detail_error);
  assert.equal(res.body.orders_7d.count,0);
});
test('checkout rejects missing, inherited and invalid tiers without contacting Stripe',async()=>{
 let calls=0;function Stripe(){this.checkout={sessions:{create:async()=>{calls++;return {url:'test'}}}}}
 const handler=load('api/create-checkout-session.js',{stripe:Stripe});
 for(const tier of [undefined,'bogus','constructor','__proto__',{},'']){const res=response();await handler({method:'POST',body:{tier}},res);assert.equal(res.code,400);}
 assert.equal(calls,0);
 for(const tier of ['summary','basic','detailed','upgrade','partner']){const res=response();await handler({method:'POST',body:{tier}},res);assert.equal(res.code,200);}
 assert.equal(calls,5);
});
