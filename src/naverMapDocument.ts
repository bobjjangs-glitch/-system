export function createNaverMapDocument(keyId = "") {
  const key = /^[A-Za-z0-9_-]{5,128}$/.test(keyId) ? keyId : "";
  return `<!doctype html><html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta name="referrer" content="strict-origin-when-cross-origin">
<style>
html,body,#map{height:100%;margin:0;background:#eef2f4;font-family:system-ui}
.number{width:32px;height:32px;box-sizing:border-box;background:#142d35;color:white;border:3px solid white;border-radius:50%;text-align:center;line-height:26px;font-weight:800;box-shadow:0 2px 8px #0003}
.driver{background:#b9ec70;color:#173628}.driver-idle{background:#dce4e0;color:#52645d}
.company{background:#faad65;color:#173628}.delivered{background:#73867e}.failed{background:#b95242}
.next{background:#2563eb;box-shadow:0 0 0 4px #2563eb44}
#fit-route{display:none;position:absolute;top:12px;left:12px;z-index:100;border:0;background:white;padding:12px 15px;font-weight:700;color:#142d35;border-radius:8px;box-shadow:0 2px 8px #0002;cursor:pointer}
#map-loading{position:absolute;top:12px;right:12px;z-index:99;padding:12px;background:white;border-radius:8px;font-size:12px;color:#52645d}
#map-error{display:none;position:absolute;inset:0;z-index:110;align-items:center;justify-content:center;flex-direction:column;padding:24px;background:#eef2f4;text-align:center;color:#52645d;font-size:14px;gap:16px}
#configure,#retry{border:0;border-radius:8px;background:#165b52;color:white;padding:12px 18px;cursor:pointer;font-weight:700}
#retry{display:none;background:white;color:#165b52}
</style></head><body><div id="map" aria-label="네이버 실시간 운행 지도"></div>
<button id="fit-route" type="button" aria-label="전체 경로 보기">전체 경로</button>
<div id="map-loading" role="status">네이버 지도를 불러오는 중이에요.</div>
<div id="map-error" role="status"><div id="error-message"></div><button id="configure" type="button">네이버 지도 설정</button><button id="retry" type="button">지도 다시 불러오기</button></div>
<script>(function(){
  const key=${JSON.stringify(key)};
  const colors=['#165b52','#5b6bbb','#d38b38','#ab65a0','#348bb8','#8b8d3b'];
  let maps=null,map=null,pending=null,failed=false,timer=null;
  let overlays=[],routePoints=[],points=[],lastRouteKey='',lastCameraKey='';
  const driverMarkers=new Map();
  function send(message){
    if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(message);
    else window.parent.postMessage(message,'*');
  }
  function error(message){
    failed=true;clearTimeout(timer);
    document.getElementById('map-loading').style.display='none';
    document.getElementById('error-message').textContent=message;
    document.getElementById('map-error').style.display='flex';
  }
  document.getElementById('configure').onclick=function(){send('dispatch-map-settings');};
  document.getElementById('retry').onclick=function(){window.location.reload();};
  if(key)document.getElementById('retry').style.display='block';
  function valid(p){return p&&Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&Math.abs(p.lat)<=90&&Math.abs(p.lng)<=180;}
  function coordinate(p){return new maps.LatLng(p.lat,p.lng);}
  function resize(){
    const el=document.getElementById('map');
    if(failed)return;
    try{if(map&&el.clientWidth&&el.clientHeight)map.setSize(new maps.Size(el.clientWidth,el.clientHeight));}
    catch(_){error('네이버 지도 인증을 확인해 주세요. Key ID와 Web 서비스 URL 설정을 확인한 뒤 다시 열어 주세요.');}
  }
  function fit(){
    if(failed)return;
    resize();if(failed||!map||!points.length)return;
    try{
      map.fitBounds(points.map(coordinate),{top:90,right:35,bottom:35,left:35});
      if(map.getZoom()>14)map.setZoom(14,false);
    }catch(_){error('네이버 지도 인증을 확인해 주세요. Key ID와 Web 서비스 URL 설정을 확인한 뒤 다시 열어 주세요.');}
  }
  document.getElementById('fit-route').onclick=fit;
  function icon(label,cls){
    const clean=String(label??'').replace(/[<>&"']/g,'');
    return {content:'<div class="number '+(cls||'')+'">'+clean+'</div>',size:new maps.Size(32,32),anchor:new maps.Point(16,16)};
  }
  function content(text){const el=document.createElement('div');el.style.cssText='padding:12px;max-width:260px;font-size:13px';el.textContent=text;return el;}
  function marker(p,label,text,cls){
    const marker=new maps.Marker({map:map,position:coordinate(p),icon:icon(label,cls),zIndex:cls==='driver'?100:10});
    const info=new maps.InfoWindow({content:content(text),borderWidth:0});
    const listener=maps.Event.addListener(marker,'click',function(){if(info.getMap())info.close();else info.open(map,marker);});
    return {marker:marker,info:info,listener:listener,label:label,cls:cls};
  }
  function remove(entry){maps.Event.removeListener(entry.listener);entry.info.close();entry.marker.setMap(null);}
  function render(data){
    if(!map||failed)return;
    const routes=Array.isArray(data.routes)?data.routes:[];
    const routeKey=JSON.stringify([data.company,routes.map(r=>[r.id,r.color,r.driverName,r.company,r.geometry,r.stops])]);
    if(routeKey!==lastRouteKey){
      for(const entry of overlays){if(entry.marker)remove(entry);else entry.setMap(null);}
      overlays=[];routePoints=[];lastRouteKey=routeKey;
      if(valid(data.company)){
        overlays.push(marker(data.company,'⌂',data.company.name+' · 출발 / 복귀','company'));
        routePoints.push(data.company);
      }
      routes.forEach(function(route,index){
        const stops=(route.stops||[]).filter(valid),geometry=(route.geometry||[]).filter(valid);
        const line=geometry.length>1?geometry:[route.company||data.company,...stops,route.company||data.company].filter(valid);
        if(line.length>1){
          overlays.push(new maps.Polyline({map:map,path:line.map(coordinate),strokeColor:route.color||colors[index%colors.length],strokeWeight:4,strokeOpacity:0.8,strokeStyle:route.estimateSource==='approximate'||geometry.length<2?'shortdash':'solid'}));
          routePoints.push(...line);
        }
        for(const stop of stops){
          const cls=stop.status==='delivered'?'delivered':stop.status==='failed'?'failed':stop.id===data.nextStopId?'next':'';
          const status=stop.status==='delivered'?'배송 완료':stop.status==='failed'?'미배송':stop.id===data.nextStopId?'다음 배송지':'배송 대기';
          overlays.push(marker(stop,stop.sequence,(route.driverName||'')+' · '+stop.sequence+'번 · '+stop.recipient+' · '+stop.address+' · '+status,cls));
          routePoints.push(stop);
        }
      });
    }
    points=routePoints.slice();
    const visible=new Set();
    for(const driver of data.drivers||[]){
      const p=driver.position;if(!valid(p))continue;
      visible.add(driver.id);
      const age=Date.now()-Date.parse(p.recordedAt);
      const sharing=age>=0&&age<120000&&routes.some(r=>r.id===p.routeId&&(r.status==='active'||r.status==='returning'));
      const label=driver.name.slice(-2),cls=sharing?'driver':'driver-idle';
      const text=driver.name+(sharing?' · 위치 수신 중':' · 마지막 수신 위치');
      const existing=driverMarkers.get(driver.id);
      if(existing){
        existing.marker.setPosition(coordinate(p));existing.info.setContent(content(text));
        if(existing.label!==label||existing.cls!==cls)existing.marker.setIcon(icon(label,cls));
        existing.marker.setZIndex(sharing?100:20);existing.label=label;existing.cls=cls;
      }else driverMarkers.set(driver.id,marker(p,label,text,cls));
      points.push(p);
    }
    for(const [id,entry] of driverMarkers)if(!visible.has(id)){remove(entry);driverMarkers.delete(id);}
    const cameraKey=JSON.stringify([data.company,routes.map(r=>[r.id,r.geometry,(r.stops||[]).map(s=>[s.id,s.sequence,s.lat,s.lng])])]);
    const changed=cameraKey!==lastCameraKey;lastCameraKey=cameraKey;
    setTimeout(function(){if(changed)fit();else resize();},60);
  }
  window.updateDispatchMap=function(data){
    if(!data||typeof data!=='object')return;pending=data;
    try{render(data);}catch(_){error('네이버 지도 인증을 확인해 주세요. Key ID와 Web 서비스 URL 설정을 확인한 뒤 다시 열어 주세요.');}
  };
  window.addEventListener('message',function(e){
    if(e.source!==window.parent&&e.source!==window)return;
    try{const d=typeof e.data==='string'?JSON.parse(e.data):e.data;if(d&&d.type==='dispatch-map')window.updateDispatchMap(d.payload);}catch(_){}
  });
  window.navermap_authFailure=function(){error('네이버 지도 인증을 확인해 주세요. 관리자 설정의 Key ID와 네이버 Cloud의 Web 서비스 URL 등록을 확인해 주세요.');};
  window.initDispatchNaverMap=function(){
    // The SDK can call back before its namespace is assigned to window.
    setTimeout(function(){
    if(map||failed)return;
    try{
      maps=window.naver.maps;
      map=new maps.Map('map',{center:new maps.LatLng(36.3504,127.3848),zoom:12,minZoom:5,maxZoom:20,zoomControl:true,zoomControlOptions:{position:maps.Position.TOP_RIGHT,style:maps.ZoomControlStyle.SMALL}});
      maps.Event.once(map,'tilesloaded',function(){
        clearTimeout(timer);document.documentElement.dataset.mapReady='true';
        document.getElementById('map-loading').style.display='none';
      });
      document.getElementById('fit-route').style.display='block';
      if(pending)render(pending);
      if(typeof ResizeObserver!=='undefined')new ResizeObserver(resize).observe(document.getElementById('map'));
      send('dispatch-map-ready');
    }catch(_){error('네이버 지도를 준비하지 못했어요. 인터넷 연결과 지도 설정을 확인해 주세요.');}
    },0);
  };
  send('dispatch-map-ready');
  if(!key){error('네이버 지도 연결이 필요해요. 관리자 지도 설정에 웹 지도용 Key ID를 입력해 주세요.');return;}
  timer=setTimeout(function(){error('네이버 지도를 불러오지 못했어요. 인터넷 연결과 지도 인증을 확인해 주세요.');},30000);
  const script=document.createElement('script');script.async=true;script.referrerPolicy='strict-origin-when-cross-origin';
  script.src='https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId='+encodeURIComponent(key)+'&callback=initDispatchNaverMap';
  script.onerror=function(){error('네이버 지도를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.');};document.head.appendChild(script);
})();</script></body></html>`;
}
