import {writeFileSync} from 'node:fs';
const pages=await fetch('http://127.0.0.1:9222/json/list').then(r=>r.json());
const page=pages.find(p=>p.type==='page'&&p.url.startsWith('http://127.0.0.1:8080/'));
const socket=new WebSocket(page.webSocketDebuggerUrl);
await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
let id=0;
async function call(method,params={}) {const n=++id;return await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('timeout')),10000);const handler=e=>{const m=JSON.parse(e.data);if(m.id===n){clearTimeout(timeout);socket.removeEventListener('message',handler);m.error?reject(Error(m.error.message)):resolve(m.result);}};socket.addEventListener('message',handler);socket.send(JSON.stringify({id:n,method,params}));});}
const read=await call('Runtime.evaluate',{expression:`JSON.stringify({url:location.href,fonts:[...document.querySelectorAll('[data-testid="volts-chart"] [data-slot="accordion-trigger"],[data-testid="volts-chart"] .recharts-text,[data-testid="volts-chart"] .recharts-legend-wrapper,[data-testid="grid"] [data-slot="accordion-trigger"],[data-testid="grid"] td span')].slice(0,25).map(e=>({text:e.textContent,font:getComputedStyle(e).fontSize,tag:e.tagName})),overflow:document.documentElement.scrollWidth>innerWidth})`,returnByValue:true});
console.log(read.result.value);
for(const [selector,name] of [['[data-testid="volts-chart"]','voltage'],['[data-testid="grid"]','ups-data']]) {
 await call('Runtime.evaluate',{expression:`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start'}); true`,returnByValue:true});
 await new Promise(r=>setTimeout(r,300));
 const image=await call('Page.captureScreenshot',{format:'png'});
 writeFileSync(`/config/kiosk-${name}.png`,Buffer.from(image.data,'base64'));
}
await call('Runtime.evaluate',{expression:'window.scrollTo(0,0)'});
socket.close();
