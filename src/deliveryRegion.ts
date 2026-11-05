export type DeliveryRegion = { key: string; label: string };
const provinces: [string, string][] = [
  ["서울특별시|서울시|서울", "서울"],
  ["부산광역시|부산시|부산", "부산"],
  ["대구광역시|대구시|대구", "대구"],
  ["인천광역시|인천시|인천", "인천"],
  ["광주광역시|광주시|광주", "광주"],
  ["대전광역시|대전시|대전", "대전"],
  ["울산광역시|울산시|울산", "울산"],
  ["세종특별자치시|세종시|세종", "세종"],
  ["경기도|경기", "경기"],
  ["강원특별자치도|강원도|강원", "강원"],
  ["충청북도|충북", "충북"],
  ["충청남도|충남", "충남"],
  ["전북특별자치도|전라북도|전북", "전북"],
  ["전라남도|전남", "전남"],
  ["경상북도|경북", "경북"],
  ["경상남도|경남", "경남"],
  ["제주특별자치도|제주도|제주", "제주"],
];
export function deliveryRegion(address: string): DeliveryRegion {
  let text = address
    .normalize("NFKC")
    .trim()
    .replace(/^대한민국\s*/, "")
    .replace(/^\(?\d{5}\)?\s*/, "")
    .replace(/\s+/g, " ");
  for (const [pattern, province] of provinces) {
    const match = text.match(new RegExp("^(?:" + pattern + ")"));
    if (!match) continue;
    if (province === "세종") return { key: "세종", label: "세종시" };
    text = text.slice(match[0].length).trim();
    const first = text.match(/^([가-힣]{1,8}?(?:시|군|구))/);
    if (!first) break;
    let area = first[1];
    if (area.endsWith("시")) {
      const rest = text.slice(area.length).trim();
      const district = rest.match(/^([가-힣]{1,8}?구)(?:\s|$)/);
      if (district) area += " " + district[1];
    }
    return { key: province + ":" + area, label: province + " " + area };
  }
  return { key: "unknown", label: "지역 확인 필요" };
}
export function deliveryRegionGroups<T extends { address: string }>(
  shipments: T[],
) {
  const map = new Map<string, { key: string; label: string; shipments: T[] }>();
  for (const stop of shipments) {
    const r = deliveryRegion(stop.address);
    if (!map.has(r.key)) map.set(r.key, { ...r, shipments: [] });
    map.get(r.key)!.shipments.push(stop);
  }
  return [...map.values()].sort((a, b) =>
    a.key === "unknown"
      ? 1
      : b.key === "unknown"
        ? -1
        : a.label.localeCompare(b.label, "ko"),
  );
}
