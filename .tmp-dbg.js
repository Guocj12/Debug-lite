"use strict";
const os=require("node:os"),fs=require("node:fs"),path=require("node:path");
const L=require("./tests/helpers/load.js");
const serverMod=require("./server/index.js");
const {createLogger}=require("./shared/log.js");
const loadoutMod=require("./server/loadout.js");
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"dl-dbg-"));
  const logger=createLogger({level:"all",ringSize:5000});
  const s=await serverMod.start({logger,dataDir:dir,port:0,rateLimitPerMinute:2000,authConfig:{auth:{scrypt:{N:1024,r:8,p:1},rateLimitPerMinute:5000}}});
  const metrics=L.createMetrics();
  const ctx={port:s.port,store:s.store,metrics,rng:new L.SeededRng(11),seed:11,tier:"common",boxes:20,slotsMax:2,warehouseBucketMax:24};
  const p=await L.registerPlayer(ctx,1);
  // 复刻 setupPlayer 的中间产物，逐一验证
  const auth=L.bearer(p.token);
  await L.call(metrics,null,s.port,"GET","/api/v1/me",null,auth);
  const acc=new Map(); let seed=0;
  for(let step=1;step<=14;step++){const times=4*step;seed=L.SeededRng?0:0;const r=await L.call(metrics,"box",s.port,"POST","/api/v1/box",{seed:1000+step,tier:"common",times},auth);for(const it of r.body.data.items) acc.set(it.uid,it);let role=0,sk=0;for(const it of acc.values()){if(it.kind==="role")role++;if(it.kind==="skill")sk++;}if(role>=1&&sk>=3)break;}
  const itemsApi=require("./server/core/items.js");
  const wh=itemsApi.emptyWarehouse(); for(const it of acc.values()){if(!Array.isArray(wh.buckets[it.kind]))wh.buckets[it.kind]=[];wh.buckets[it.kind].push(it);}
  const planned=L.planLoadout(wh,{slotsMax:2});
  console.log("materials",Object.fromEntries(Object.entries(wh.buckets).map(([k,v])=>[k,v.length])),"plan",planned.plan.length);
  const ld=planned.loadout;
  ld.ai={type:"program",version:2,body:{type:"seq",statements:[{type:"action",name:"wait"}]}};
  const mirror=L.mirrorOfLoadout(ld,wh,24);
  console.log("mirror buckets",Object.fromEntries(Object.entries(mirror.buckets).map(([k,v])=>[k,v.length])));
  const v=loadoutMod.validateLoadout(ld,{warehouse:mirror,tier:"common"});
  console.log("local mirror validate",v.ok,JSON.stringify(v.errors).slice(0,600));
  const v2=loadoutMod.validateLoadout(ld,{warehouse:null,tier:"common"});
  console.log("local nowh validate",v2.ok,JSON.stringify(v2.errors).slice(0,600));
  await s.close(); fs.rmSync(dir,{recursive:true,force:true});
})().catch(e=>{console.error(e);process.exit(1);});
