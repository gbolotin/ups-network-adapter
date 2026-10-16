import assert from 'node:assert/strict';
const pages=await fetch('http://127.0.0.1:9222/json/list').then(r=>r.json());
const page=pages.find(p=>p.type==='page'&&p.url.startsWith('http://127.0.0.1:8080/'));
const socket=new WebSocket(page.webSocketDebuggerUrl);
await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
let id=0;
async function call(method,params={}) {const n=++id;return await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('timeout')),10000);const handler=e=>{const m=JSON.parse(e.data);if(m.id===n){clearTimeout(timeout);socket.removeEventListener('message',handler);m.error?reject(Error(m.error.message)):resolve(m.result);}};socket.addEventListener('message',handler);socket.send(JSON.stringify({id:n,method,params}));});}
await call('Page.reload');
let state;
for(let attempt=0;attempt<20;attempt++) {
 await new Promise(resolve=>setTimeout(resolve,500));
 const reply=await call('Runtime.evaluate',{expression:`JSON.stringify((()=>{const font=selector=>{const e=document.querySelector(selector);return e?getComputedStyle(e).fontSize:null;};const legend=[...document.querySelectorAll('[data-testid="volts-chart"] .recharts-legend-wrapper *')].find(e=>e.textContent.trim()==='Input Voltage');return {heading:font('[data-testid="volts-chart"] [data-slot="accordion-trigger"]'),axis:font('[data-testid="volts-chart"] .recharts-text'),legend:legend?getComputedStyle(legend).fontSize:null,dataHeading:font('[data-testid="grid"] [data-slot="accordion-trigger"]'),cell:font('[data-testid="grid"] td span'),gauge:font('[data-testid="gauge"] tspan'),overflow:document.documentElement.scrollWidth>innerWidth,width:innerWidth,height:innerHeight};})())`,returnByValue:true});
 state=JSON.parse(reply.result.value);
 if(state.axis&&state.cell&&state.legend)break;
}
assert.equal(state.heading,'22px');assert.equal(state.axis,'18px');assert.equal(state.legend,'18px');assert.equal(state.dataHeading,'22px');assert.equal(state.cell,'20px');assert.equal(state.gauge,'48px');assert.equal(state.overflow,false);assert.equal(state.width,1024);assert.equal(state.height,600);
console.log('Readability checks passed after a page reload:',JSON.stringify(state));
await call('Runtime.evaluate',{expression:'window.scrollTo(0,0)'});socket.close();
