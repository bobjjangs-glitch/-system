import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createDispatchApp } from "../app.ts";
const date="2026-11-06";
async function fixture(t:any){
 const dir=await mkdtemp(join(tmpdir(),"admin-delete-")),r=createDispatchApp({dataDir:dir,test:true,roadRouting:false,autoGeocode:false});
 r.store.createUser("admin","관리자","631792");const driver=r.store.createUser("driver","기사","827493");
 const admin=r.store.login("631792")!.token,token=r.store.login("827493")!.token;
 r.server.listen(0,"127.0.0.1");await once(r.server,"listening");
 t.after(async()=>{await r.close();await rm(dir,{recursive:true,force:true});});
 const base="http://127.0.0.1:"+(r.server.address() as any).port;
 const api=async(path:string,body?:any,auth=admin)=>{const res=await fetch(base+path,{method:"DELETE",headers:{Authorization:"Bearer "+auth,"Content-Type":"application/json"},body:JSON.stringify(body??{})});return {status:res.status,data:await res.json()};};
 const receipt=async(status="sales-list")=>{const id=randomUUID(),file=id+".json";await writeFile(join(dir,"uploads",file),"{}");r.store.run("INSERT INTO imports(id,fileName,storedName,mime,drafts,status,serviceDate,createdAt,count) VALUES(?,?,?,?,?,?,?,?,?)",id,"회사ERP_판매목록_2026-11-06.json",file,"application/json","[]",status,date,new Date().toISOString(),1);return{id,path:join(dir,"uploads",file)};};
 const route=()=>{const id=randomUUID();r.store.run("INSERT INTO routes(id,driverId,serviceDate,status,distanceKm,durationMinutes,estimateSource,geometry,company) VALUES(?,?,?,'active',10,30,'static','[]',?)",id,driver.id,date,JSON.stringify(r.store.company()));return id;};
 const stop=(importId:string,routeId:string|null,status="assigned")=>{const id=randomUUID();r.store.run("INSERT INTO shipments(id,importId,recipient,address,items,lat,lng,serviceDate,status,routeId,sequence,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",id,importId,"가상 거래처","대전광역시 서구 가상로 1",JSON.stringify([{name:"물품",quantity:2}]),36.3,127.4,date,status,routeId,1,new Date().toISOString());return id;};
 return{r,api,receipt,route,stop,driver,driverToken:token};
}
test("판매조회 JSON 기록은 기본 삭제 API와 관리자 API에서 삭제되며 회사 ERP를 호출하지 않는다",async(t)=>{
 const f=await fixture(t),a=await f.receipt(),b=await f.receipt();
 assert.equal((await f.api("/api/imports/"+a.id)).status,200);assert.equal(existsSync(a.path),false);
 assert.equal((await f.api("/api/admin/records/imports/"+b.id)).status,200);assert.equal(existsSync(b.path),false);
});
test("관리자가 운행 중 전표의 기록만 지우면 배송지·코스는 보존하고 참조를 분리한다",async(t)=>{
 const f=await fixture(t),b=await f.receipt("committed"),route=f.route(),stop=f.stop(b.id,route);
 const result=await f.api("/api/admin/records/imports/"+b.id);assert.equal(result.status,200);assert.equal(result.data.keptShipments,1);
 assert.equal(f.r.store.one("SELECT importId FROM shipments WHERE id=?",stop).importId,null);
 assert.equal(f.r.store.one("SELECT status FROM routes WHERE id=?",route).status,"active");
});
test("관리자가 완료·운행 배송지를 삭제할 수 있고 마지막 배송지를 지우면 위치·코스 참조도 정리한다",async(t)=>{
 const f=await fixture(t),b=await f.receipt("committed"),route=f.route(),first=f.stop(b.id,route,"delivered"),second=f.stop(b.id,route);
 f.r.store.run("INSERT INTO positions(driverId,routeId,lat,lng,recordedAt) VALUES(?,?,?,?,?)",f.driver.id,route,36.3,127.4,new Date().toISOString());
 assert.equal((await f.api("/api/admin/records/shipments/"+first)).status,200);
 assert.equal(f.r.store.one("SELECT sequence FROM shipments WHERE id=?",second).sequence,1);
 assert.equal((await f.api("/api/admin/records/shipments/"+second)).status,200);
 assert.equal(f.r.store.one("SELECT id FROM routes WHERE id=?",route),undefined);assert.equal(f.r.store.one("SELECT driverId FROM positions WHERE driverId=?",f.driver.id),undefined);
});
test("관리자가 코스·기사 계정을 삭제하면 배송 대기는 미배차가 되고 로그인 세션은 폐기된다",async(t)=>{
 const f=await fixture(t),b=await f.receipt(),route=f.route(),stop=f.stop(b.id,route);
 assert.equal((await f.api("/api/admin/records/routes/"+route)).status,200);
 const moved=f.r.store.one("SELECT routeId,status FROM shipments WHERE id=?",stop);assert.equal(moved.routeId,null);assert.equal(moved.status,"pending");
 assert.equal((await f.api("/api/admin/records/drivers/"+f.driver.id)).status,200);assert.equal(f.r.store.login("827493"),null);
});
test("전표와 배송지를 함께 삭제하는 선택은 완료 건도 정리하며 기사에게 관리자 삭제 권한을 주지 않는다",async(t)=>{
 const f=await fixture(t),b=await f.receipt("committed"),route=f.route();f.stop(b.id,route,"delivered");
 assert.equal((await f.api("/api/admin/records/imports/"+b.id,{deleteLinked:true},f.driverToken)).status,403);
 const result=await f.api("/api/admin/records/imports/"+b.id,{deleteLinked:true});assert.equal(result.status,200);assert.equal(result.data.deletedShipments,1);
 assert.equal(f.r.store.one("SELECT id FROM routes WHERE id=?",route),undefined);assert.equal(f.r.store.one("SELECT id FROM imports WHERE id=?",b.id),undefined);
 assert.equal((await f.api("/api/admin/records/users/unknown")).status,404);
});
