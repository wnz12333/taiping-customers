(function workerRuntime({version,hashes,fetchTimeout}){
 const PREFIX='taiping-static-',CACHE=PREFIX+version;
 const scope=new URL(self.registration.scope),entries=Object.entries(hashes);
 const resources=new Map(entries.map(([name,hash])=>[new URL(name,scope).href,{name,hash}]));
 const indexURL=new URL('index.html',scope).href;
 let repairing,scanning;
 function bounded(promise,ms,onTimeout){
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>{onTimeout?.();reject(new Error('资源下载超时，请确认网络后重试'));},ms);})]).finally(()=>clearTimeout(timer));
 }
 async function sha256(response){
  const bytes=await response.clone().arrayBuffer();
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
 }
 async function valid(response,expected){return !!response&&response.ok&&(!expected||await sha256(response)===expected.hash);}
 async function verifiedFetch(url){
  const resource=resources.get(url);if(!resource)throw new Error('资源不在离线清单中');
  const controller=new AbortController();
  return bounded((async()=>{
   const response=await fetch(new Request(url,{cache:'reload',signal:controller.signal}));
   if(!response.ok)throw new Error('资源暂时无法下载，请确认网络后重试');
   if(await sha256(response)!==resource.hash)throw new Error('资源版本已变化，请检查更新后重试');
   return response;
  })(),fetchTimeout,()=>controller.abort());
 }
 async function status(){
  const cache=await caches.open(CACHE),items=[...resources],unusable=new Array(items.length);let next=0;
  async function inspect(){while(next<items.length){const index=next++,[url,resource]=items[index];if(!await valid(await cache.match(url),resource))unusable[index]=resource.name;}}
  // Bound memory on phones while avoiding a serial disk/hash roundtrip for
  // every image and font. Concurrent STATUS callers share this scan.
  await Promise.all([inspect(),inspect()]);
  const missing=unusable.filter(Boolean);return {ready:missing.length===0,version:CACHE,missing};
 }
 async function safeStatus(){
  if(!scanning)scanning=status().finally(()=>{scanning=null;});
  try{return await bounded(scanning,5000);}catch(error){return{ready:false,version:CACHE,missing:entries.map(([name])=>name),error:error.message||'无法检查离线资源'};}
 }
 async function previousCopy(url,expected){
  for(const name of (await caches.keys()).filter(name=>name.startsWith(PREFIX)&&name!==CACHE)){
   const response=await(await caches.open(name)).match(url);
   if(await valid(response,expected))return response;
  }
 }
 async function repairMissing(){
  const initial=await safeStatus();if(initial.error||initial.ready)return initial;
  const cache=await caches.open(CACHE);
  const results=await Promise.allSettled(initial.missing.map(async name=>{
   const url=new URL(name,scope).href;
   const response=await previousCopy(url,resources.get(url))||await verifiedFetch(url);
   await bounded(cache.put(url,response),5000);
  }));
  const result=await safeStatus(),failure=results.find(item=>item.status==='rejected');
  if(failure&&!result.ready)result.error=failure.reason?.message||'部分离线资源下载失败，请重试';
  return result;
 }
 function repair(){
  if(!repairing)repairing=repairMissing().catch(error=>({ready:false,version:CACHE,missing:entries.map(([name])=>name),error:error.message||'离线修复未完成'})).finally(()=>{repairing=null;});
  return repairing;
 }
 self.addEventListener('install',event=>event.waitUntil((async()=>{
  const result=await repair();
  // Never delete a shared version cache on failure: another worker can be
  // installing that same build, or an active worker can still be using it.
  // Verified fragments are safe to reuse on the next install attempt.
  if(!result.ready)throw new Error(result.error||'离线资源未完整下载');
 })()));
 async function pruneAfterNavigation(event){
  if(!event.resultingClientId||!self.clients.matchAll)return;
  const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  if(clients.some(client=>client.id!==event.clientId&&client.id!==event.resultingClientId&&client.url.startsWith(scope.href)))return;
  const keys=[];
  for(const key of (await caches.keys()).filter(key=>key.startsWith(PREFIX))){
   if(key===CACHE){keys.push(key);continue;}
   // CacheStorage belongs to the entire origin. Other hosted applications
   // and caches shared with another path must not be removed here.
   const requests=await(await caches.open(key)).keys();
   if(requests.length&&requests.every(request=>request.url.startsWith(scope.href)))keys.push(key);
  }
  const keep=new Set([CACHE,...keys.filter(key=>key!==CACHE).slice(-2)]);
  await Promise.all(keys.filter(key=>!keep.has(key)).map(key=>caches.delete(key)));
 }
 // Keep old lazy-loaded modules until a new document is served and no other
 // application page is open. Activation alone does not prove old pages left.
 self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
 self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==scope.origin||!url.pathname.startsWith(scope.pathname))return;
  const response=(async()=>{
   url.search='';url.hash='';
   const key=request.mode==='navigate'?indexURL:url.href,expected=resources.get(key),cache=await caches.open(CACHE);
   const cached=await cache.match(key);if(await valid(cached,expected))return cached;
   // Old open pages can still request their earlier hashed JS/CSS files.
   const old=await previousCopy(key,expected);
   if(old){
    if(expected)try{await bounded(cache.put(key,old.clone()),5000);}catch{}
    return old;
   }
   if(!expected)return fetch(request);
   const response=await verifiedFetch(key);
   // An online page remains usable if the device cannot allocate more cache.
   try{await bounded(cache.put(key,response.clone()),5000);}catch{}
   return response;
  })();
  event.respondWith(response);
  if(request.mode==='navigate')event.waitUntil(response.then(()=>pruneAfterNavigation(event)).catch(()=>{}));
 });
 self.addEventListener('message',event=>{
  if(event.data?.type==='ACTIVATE'){
   event.waitUntil((async()=>{
    let result=await repair();
    if(result.ready)try{await self.skipWaiting();}catch(error){result={...result,ready:false,error:error.message||'更新暂未切换，旧版本继续保留'};}
    event.ports[0]?.postMessage(result);
   })());return;
  }
  if(event.data?.type==='STATUS'||event.data?.type==='REPAIR')event.waitUntil((async()=>{
   const result=await(event.data.type==='REPAIR'?repair():safeStatus());
   event.ports[0]?.postMessage(result);
  })());
 });
})({"version":"c2ac36dda93a7002","hashes":{"app-icon.png":"441c91b953e0e1824bab7300eafe6c1c3fda9ae431cb3d1c3478d084fa711847","apple-touch-icon.png":"bc55bc0c119e669dfd381515d944e6b3c59bc4bc7d8d7bbb96cfe48291a0711d","assets/excel-import-BrA6vy25.js":"0000714a5cfcfa50abf7ed15ac1c34cca757b663b1893ab14bae70001e3ab1b7","assets/export-D4MA6SBH.js":"1bae7ff09da672d533e22f1111de9d8bb57ea597bfbb2ead551dbe1347733e06","assets/index-1Vr_-Erp.js":"814397f24deda6449164586258daa8ab990988c3ed8293f7bbc6c288f8668a40","assets/index-DU6c6xea.css":"3d8a7792ad159c9f27eeaf8527bce11d9f4f6c989fc0275fabdf583c4ae4ed9b","assets/main-BfneZYUD.css":"3502ad7c4f836f5afb90dee2b3cb3ffbe125f5ce8f4b3f136acde79373bd6315","assets/main-BZ294nut.js":"1f709bd19b64a5c4d6b757133cb1e4d347ac4840317180bed951737346b9ec1f","customer-template.xlsx":"1436ff6e51ea429de50d983d87ae9ff1586079e7caa0e3378f0262af2e1b2975","EXCEL_IMPORT_LICENSES.txt":"4a99fc3ba67be581d2b7fb88617134ebf590c8b7d1aec2c2bdffe5828fba2d87","fonts/LXGWWenKaiLite-Regular.ttf":"f799a538a3355877e597a0ae04050e897932c9ae7689eb9227c2953c5dd549ea","fonts/OFL.txt":"0333a85fe077b6849f8e417acc44e8bd879442ceb681e271acf93e2d57fd4e2e","icon.svg":"0157f28da88af85eb5ec97f8bf47df809cbd20b8895d0cd47277f571bbb7707f","index.html":"c097df5f4010a995389d090ee8e46c894af1113810c21a4cd91abf34510cf738","manifest.webmanifest":"75d223f48fc78c6b8da2fdde6d60fb87b87dbe7f8ba9cb285ad1476ceec3cee7","pwa-icon.png":"5c3734f89a3ce5480433359ab05e881db5f547a7ab3213c84322752ae5ad37f9","themes/journal-leaf.png":"4c0006b7b5c0351b6db61585fcd6a09986558f820c158173e2ea9af596ded229","themes/journal-peach.png":"59f57c4f1a34edd6bf176bced432b72a7f2cbc6001f8508cc96c33f30ec0d6c8","themes/journal-sky.png":"e3daf5e70c002ed98306e3380818dd9a18137835aa32a0243619b1261179564b","themes/lavender.svg":"2588e2dc2b5a1e390ddb9e89a703211eacf0d56d82839dfc7ff8c50d9af974e8","themes/real-bloom.png":"f5ff901998a85f73a6484470824ab093e61dea46c06782e612fb1e69870a537c","themes/real-coast.png":"55827e5298ba2377d2b7574e6f71927adb32e8a4103721c5e84998b4a3517533","themes/real-forest.png":"badf2f4b970b5bff06c3a78edb441cfd62ec5b42cc82a33067e0ae6af463c356","themes/sage.svg":"d2eb0e834e7866f3f918c11fc14ad0a2fabd4cd46886727c36d97a3bf86d3766","themes/waves.svg":"9cc8836049beb97ad116612772a3164c96e9d5d36961f4c8ef0b8caf77259d9a","THIRD_PARTY_NOTICES.txt":"b57c6f48623a57e3f51cccabeb79aac060d2e2c183f9894057dc8aefbe5bc726"},"fetchTimeout":30000});
