import type { Store } from "./database.ts";
import { id, today, defaultCompany } from "./database.ts";
import { randomInt } from "node:crypto";
const destinations: [string, string, number, number][] = [
  ["대전역", "대전 동구 중앙로 215", 36.3326, 127.4347],
  ["중앙시장", "대전 동구 대전로 783", 36.329, 127.4315],
  ["대전문학관", "대전 동구 송촌남로11번길 116", 36.355, 127.432],
  ["한밭교육박물관", "대전 동구 우암로 96", 36.339, 127.4291],
  ["우암사적공원", "대전 동구 충정로 53", 36.3455, 127.459],
  ["한밭도서관", "대전 중구 서문로 10", 36.3044, 127.4106],
  ["서대전공원", "대전 중구 계룡로 904", 36.3215, 127.4095],
  ["보문산공원", "대전 중구 보문산공원로 252", 36.306, 127.424],
  ["대전아쿠아리움", "대전 중구 보문산공원로 469", 36.3068, 127.4206],
  ["중구청", "대전 중구 중앙로 100", 36.3256, 127.421],
  ["대전시청", "대전 서구 둔산로 100", 36.3504, 127.3848],
  ["한밭수목원", "대전 서구 둔산대로 169", 36.3675, 127.3887],
  ["대전예술의전당", "대전 서구 둔산대로 135", 36.367, 127.3824],
  ["정부대전청사", "대전 서구 청사로 189", 36.3619, 127.3848],
  ["갈마도서관", "대전 서구 신갈마로127번길 138", 36.3499, 127.3673],
  ["유성온천공원", "대전 유성구 봉명동 574", 36.354, 127.3422],
  ["충남대학교", "대전 유성구 대학로 99", 36.3687, 127.3441],
  ["국립중앙과학관", "대전 유성구 대덕대로 481", 36.376, 127.3765],
  ["엑스포과학공원", "대전 유성구 대덕대로 480", 36.3776, 127.3866],
  ["카이스트", "대전 유성구 대학로 291", 36.3706, 127.3622],
  ["대덕구청", "대전 대덕구 대전로1033번길 20", 36.3468, 127.4155],
  ["동춘당", "대전 대덕구 동춘당로 80", 36.365, 127.439],
  ["중리시장", "대전 대덕구 중리북로 31", 36.363, 127.4243],
  ["오정농수산시장", "대전 대덕구 한밭대로 987", 36.3583, 127.4076],
  ["송촌도서관", "대전 대덕구 송촌로 59", 36.3687, 127.4411],
];
export function seedDemo(store: Store) {
  if (
    store.one("SELECT id FROM shipments LIMIT 1") ||
    store.one("SELECT id FROM users WHERE role=? LIMIT 1", "driver")
  )
    throw new Error(
      "예시 데이터는 기사와 배송지가 없는 상태에서만 추가할 수 있습니다.",
    );
  return store.transaction(() => {
    const pins = [];
    const shipmentIds: string[] = [];
    for (let i = 1; i <= 5; i++) {
      let pin: string;
      do {
        pin = String(randomInt(100000, 1000000));
      } while (
        store.one("SELECT id FROM users WHERE pinIndex=?", store.pinIndex(pin))
      );
      const driver = store.createUser("driver", `기사 ${i}`, pin);
      pins.push({ ...driver, pin });
    }
    for (let i = 0; i < destinations.length; i++) {
      const [name, address, lat, lng] = destinations[i];
      const shipmentId = id();
      shipmentIds.push(shipmentId);
      store.run(
        "INSERT INTO shipments(id,recipient,address,items,notes,lat,lng,serviceDate,createdAt) VALUES(?,?,?,?,?,?,?,?,?)",
        shipmentId,
        `${name} · 예시`,
        address,
        JSON.stringify([
          {
            name: ["생수", "식자재", "문구류", "생활용품", "포장재"][i % 5],
            quantity: 1 + (i % 4),
          },
        ]),
        "대전 공개 장소를 사용한 검증용 데이터입니다. 좌표는 예시입니다.",
        lat,
        lng,
        today(),
        new Date().toISOString(),
      );
    }
    store.run(
      "INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)",
      "demo",
      "true",
    );
    store.run(
      "INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)",
      "demoIds",
      JSON.stringify({
        drivers: pins.map((d) => d.id),
        shipments: shipmentIds,
      }),
    );
    store.run(
      "INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)",
      "company",
      JSON.stringify(defaultCompany),
    );
    return pins;
  });
}
