import { createNaverMapDocument } from "./naverMapDocument.ts";

// Naver uses the hosted document so SDK authentication sees the registered HTTPS origin.
export function createMapDocument(
  apiUrl = "",
  options?: { provider?: string; naverKeyId?: string },
) {
  if (options?.provider === "naver")
    return createNaverMapDocument(options.naverKeyId);
  const assets = (apiUrl.replace(/\/$/, "") + "/leaflet/").replace(
    /[&"<>]/g,
    (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]!,
  );
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1" />
  <link rel="stylesheet" href="${assets}leaflet.css" />
  <style>
    html,body,#map{height:100%;margin:0;background:#eef2f4;font-family:system-ui}
    .number{background:#142d35;color:white;border:3px solid white;border-radius:50%;text-align:center;line-height:27px;font-weight:800;box-shadow:0 2px 8px #0003}
    .driver{background:#b9ec70;color:#173628}
    .driver-idle{background:#dce4e0;color:#52645d}
    .company{background:#faad65;color:#173628}
    .delivered{background:#73867e}
    .failed{background:#b95242}
    .next{background:#2563eb;box-shadow:0 0 0 4px #2563eb44,0 2px 8px #0003}
    .leaflet-control-attribution{font-size:9px}
    .leaflet-popup-content{font-size:13px}
    .fit-route{border:0;background:white;padding:11px 14px;font:700 13px system-ui;color:#142d35;cursor:pointer;border-radius:4px;min-height:44px}
    #map-error{display:none;position:absolute;inset:30% 15%;text-align:center;font-size:14px;color:#52645d}

.driver-pin{width:104px;height:74px;display:flex;align-items:center;flex-direction:column;filter:drop-shadow(0 3px 4px #0005);background:transparent;border:0;line-height:normal;box-sizing:border-box}
.driver-dot{width:46px;height:46px;border:4px solid white;border-radius:50%;background:#145c4c;display:flex;align-items:center;justify-content:center;color:white;box-sizing:border-box;position:relative}
.driver-pin.driver-idle .driver-dot{background:#758179}.driver-name{margin-top:3px;background:#173e35;color:white;border:2px solid white;border-radius:8px;padding:3px 8px;font-size:12px;font-weight:800;white-space:nowrap;max-width:104px;overflow:hidden;text-overflow:ellipsis}
.driver-pin.driver-idle .driver-name{background:#66736c}.driver-pin.driver .driver-dot:before{content:'';position:absolute;inset:-8px;border:3px solid #43b88a77;border-radius:50%;animation:driver-pulse 2s infinite}
@keyframes driver-pulse{50%{transform:scale(1.18);opacity:.3}}@media(prefers-reduced-motion:reduce){.driver-dot:before{animation:none!important}}
</style>
</head>
<body>
  <div id="map"></div>
  <div id="map-error">지도를 불러오지 못했어요. 인터넷 연결을 확인한 뒤 다시 열어 주세요.</div>
  <script src="${assets}leaflet.js"></script>
  <script>
  (function () {
    if (!window.L) { document.getElementById('map-error').style.display='block'; return; }
    const map=L.map('map',{zoomControl:false}).setView([36.3504,127.3848],12);
    L.control.zoom({position:'bottomright'}).addTo(map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
      maxZoom:19,
      referrerPolicy:'strict-origin-when-cross-origin',
      attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    const layer=L.layerGroup().addTo(map);
    const driverLayer=L.layerGroup().addTo(map),driverMarkers=new Map();
    const colors=['#165b52','#5b6bbb','#d38b38','#ab65a0','#348bb8','#8b8d3b'];
    let lastKey='',bounds=null;
    function valid(p) {
      return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
        Math.abs(p.lat)<=90 && Math.abs(p.lng)<=180;
    }
    function fitRoute() {
      map.invalidateSize();
      if (bounds) map.fitBounds(bounds.pad(0.16),{maxZoom:14,animate:false});
    }
    const fitControl=L.control({position:'topleft'});
    fitControl.onAdd=function () {
      const box=L.DomUtil.create('div','leaflet-bar');
      const button=L.DomUtil.create('button','fit-route',box);
      button.type='button'; button.textContent='전체 경로';
      button.setAttribute('aria-label','전체 경로 보기');
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.on(button,'click',fitRoute);
      return box;
    };
    fitControl.addTo(map);
    function icon(label,cls) {
      if(cls==='driver'||cls==='driver-idle')return L.divIcon({className:'driver-pin '+cls,html:'<span class="driver-dot"><svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M3 4h11v12H3zM14 9h4l3 4v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></svg></span><span class="driver-name">'+String(label).replace(/[<>&"']/g,'')+'</span>',iconSize:[104,74],iconAnchor:[52,23]});
      return L.divIcon({
        className:'number '+(cls||''),html:String(label).replace(/[<>&]/g,''),
        iconSize:[30,30],iconAnchor:[15,15]
      });
    }
    function popup(text) {
      const content=document.createElement('div'); content.textContent=text; return content;
    }
    function marker(p,label,text,cls,group=layer) {
      if (!valid(p)) return;
      return L.marker([p.lat,p.lng],{icon:icon(label,cls),zIndexOffset:cls==='driver'?1200:cls==='driver-idle'?1100:0}).bindPopup(popup(text)).addTo(group);
    }
    window.updateDispatchMap=function (data) {
      layer.clearLayers();
      const points=[],routes=data.routes||[];
      if (valid(data.company)) {
        marker(data.company,'⌂',data.company.name+' · 출발 / 복귀','company');
        points.push([data.company.lat,data.company.lng]);
      }
      for (const [rIndex,route] of routes.entries()) {
        const stops=(route.stops||[]).filter(valid);
        const geometry=(route.geometry||[]).filter(valid);
        const line=geometry.length>1 ? geometry :
          [route.company||data.company,...stops,route.company||data.company].filter(valid);
        if (line.length>1) {
          const coordinates=line.map(p=>[p.lat,p.lng]);
          L.polyline(coordinates,{
            color:colors[rIndex%colors.length],weight:4,opacity:0.8,
            dashArray:route.estimateSource==='approximate'||geometry.length<2 ? '6 8' : undefined
          }).addTo(layer);
          for (const coordinate of coordinates) points.push(coordinate);
        }
        for (const stop of stops) {
          const cls=stop.status==='delivered' ? 'delivered' :
            stop.status==='failed' ? 'failed' : stop.id===data.nextStopId ? 'next' : '';
          const status=stop.status==='delivered' ? '배송 완료' :
            stop.status==='failed' ? '미배송' : stop.id===data.nextStopId ? '다음 배송지' : '배송 대기';
          marker(stop,stop.sequence,(route.driverName||'')+' · '+stop.sequence+'번 · '+
            stop.recipient+' · '+stop.address+' · '+status,cls);
          points.push([stop.lat,stop.lng]);
        }
      }
      const visibleDrivers=new Set();
      for (const driver of data.drivers||[]) {
        const p=driver.position;
        if (valid(p)) {
          const age=Date.now()-Date.parse(p.recordedAt);
          const sharing=age>=0 && age<120000 && routes.some(r=>
            r.id===p.routeId && (r.status==='active'||r.status==='returning'));
          const label=driver.name.slice(0,12),cls=sharing ? 'driver' : 'driver-idle';
          const text=driver.name+(sharing ? ' · 위치 수신 중' : ' · 마지막 수신 위치');
          visibleDrivers.add(driver.id);
          const existing=driverMarkers.get(driver.id);
          if (existing) {
            existing.marker.setLatLng([p.lat,p.lng]).setPopupContent(popup(text));
            if (existing.label!==label || existing.cls!==cls) existing.marker.setIcon(icon(label,cls));
            existing.label=label; existing.cls=cls;
          } else driverMarkers.set(driver.id,{marker:marker(p,label,text,cls,driverLayer),label,cls});
          points.push([p.lat,p.lng]);
        }
      }
      for (const [id,entry] of driverMarkers) if (!visibleDrivers.has(id)) {
        driverLayer.removeLayer(entry.marker);driverMarkers.delete(id);
      }
      bounds=points.length ? L.latLngBounds(points) : null;
      // Delivery status and live positions must not undo a user's pan or zoom.
      const key=JSON.stringify([data.company,routes.map(r=>[
        r.id,r.geometry,(r.stops||[]).map(s=>[s.id,s.sequence,s.lat,s.lng])
      ])]);
      const changed=key!==lastKey;
      lastKey=key;
      setTimeout(function () { if (changed) fitRoute(); else map.invalidateSize(); },60);
    };
    window.addEventListener('message',function (e) {
      if (e.source!==window.parent && e.source!==window) return;
      try {
        const data=typeof e.data==='string' ? JSON.parse(e.data) : e.data;
        if (data && data.type==='dispatch-map') window.updateDispatchMap(data.payload);
      } catch (_) {}
    });
    if (typeof ResizeObserver!=='undefined') new ResizeObserver(function () {
      map.invalidateSize();
    }).observe(document.getElementById('map'));
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage('ready');
    else window.parent.postMessage('dispatch-map-ready','*');
  })();
  </script>
</body>
</html>`;
}
