"use strict";
const L=require("./tests/helpers/load.js");
const fs=require("fs");
(async()=>{
  const report=await L.runLoadTest({players:6,concurrency:3,fastAuth:true,keepDataDir:true,level:"error",seed:20260918});
  const store=report.serverHandle.store;
  const registry=new Map();
  for(const pid of store.index.playerIds()){const e=store.index.get(pid);registry.set(pid,{publicId:e.publicId,isBot:!!e.isBot,tier:e.tier,points:e.points,preset:null,programHash:null,equipped:0});}
  const per=new Map(); for(const pid of registry.keys())per.set(pid,{attack:0,defense:0,points:0,delta:0});
  let jd=0;
  await store.replayJournal({includeCheckpoints:false},(r)=>{ if(r.type!=="battle.recorded")return; const a=r.p1||{},b=r.p2||{}; jd+=(a.pointsAfter-a.pointsBefore)+(b.pointsAfter-b.pointsBefore); const s1=per.get(a.playerId),s2=per.get(b.playerId); if(s1){s1.attack++;s1.points=a.pointsAfter;s1.delta+=a.pointsAfter-a.pointsBefore;} if(s2){s2.defense++;s2.points=b.pointsAfter;s2.delta+=b.pointsAfter-b.pointsBefore;} });
  console.log("journalDelta",jd);
  let sum=0,sumd=0;
  for(const pid of registry.keys()){
    const ar=await store.loadArchive(pid);
    const p=per.get(pid); const st=ar.record.stats;
    const atkCount=st.attack.wins+st.attack.losses+st.attack.draws;
    const defCount=st.defense.wins+st.defense.losses+st.defense.draws;
    if(atkCount!==p.attack||defCount!==p.defense||ar.rating.points!==p.points){
      console.log("MISMATCH",pid,"atk",atkCount,"vs",p.attack,"def",defCount,"vs",p.defense,"points",ar.rating.points,"vs",p.points,"delta",p.delta,"appliedSeq",ar.record.appliedSeq,"recent",ar.record.recent.length);
    }
    sum+=ar.rating.points; sumd+=p.delta;
  }
  console.log("archiveSum",sum,"perDeltaSum",sumd,"maxSeq",store.maxSeq());
  await L.closeReport(report);
})().catch(e=>{console.error(e);process.exit(1);});
