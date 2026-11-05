import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../database.ts";
import {
  createGeocoder,
  GeocodingError,
  normalizeGeocodingAddress,
} from "../geocoding.ts";

const point = { lat: 36.2719407, lng: 127.4680343 };
const credentials = {
  NAVER_GEOCODING_KEY_ID: "test-geocoding-id",
  NAVER_GEOCODING_KEY_SECRET: "test-geocoding-secret",
};
const naverBody = () => ({
  status: "OK",
  addresses: [{ x: String(point.lng), y: String(point.lat) }],
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
type Call = { url: URL; headers: Headers; signal?: AbortSignal | null };
function mock(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (input: any, init?: RequestInit) => {
    const call = {
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      signal: init?.signal,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, fetcher };
}
async function temporaryStore(run: (store: Store) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-geocoding-"));
  const store = new Store(dir);
  try {
    await run(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
function errorCode(code: string, status?: number) {
  return (error: unknown) =>
    error instanceof GeocodingError &&
    error.code === code &&
    (status === undefined || error.status === status);
}

test("네이버 전용 서버 인증을 우선하고 좌표 없이 입력한 주소를 정확한 원문 키로 저장한다", async () => {
  await temporaryStore(async (store) => {
    const transport = mock(() => json(naverBody()));
    const lookup = createGeocoder({
      env: {
        ...credentials,
        NAVER_DIRECTIONS_KEY_ID: "other-id",
        NAVER_DIRECTIONS_KEY_SECRET: "other-secret",
        KAKAO_REST_API_KEY: "unused-kakao",
      },
      fetcher: transport.fetcher,
    });
    const address = "대전 동구 물류로14번길 13 검증동";
    assert.deepEqual(await lookup(store, address), point);
    assert.equal(transport.calls.length, 1);
    const call = transport.calls[0];
    assert.equal(
      call.url.origin + call.url.pathname,
      "https://maps.apigw.ntruss.com/map-geocode/v2/geocode",
    );
    assert.equal(call.url.searchParams.get("query"), address);
    assert.equal(
      call.headers.get("x-ncp-apigw-api-key-id"),
      credentials.NAVER_GEOCODING_KEY_ID,
    );
    assert.equal(
      call.headers.get("x-ncp-apigw-api-key"),
      credentials.NAVER_GEOCODING_KEY_SECRET,
    );
    assert.equal(
      call.url.href.includes(credentials.NAVER_GEOCODING_KEY_SECRET),
      false,
    );
    assert.deepEqual(
      {
        ...store.one<typeof point>(
          "SELECT lat,lng FROM geocodes WHERE address=?",
          address,
        ),
      },
      point,
    );
    assert.deepEqual(await lookup(store, address), point);
    assert.equal(transport.calls.length, 1);
  });
});

test("전용 인증이 없으면 Directions 인증을 재사용하고 공개 지도 Key ID는 서버 인증으로 사용하지 않는다", async () => {
  await temporaryStore(async (store) => {
    const rows = [
      {
        env: {
          NAVER_DIRECTIONS_KEY_ID: "directions-id",
          NAVER_DIRECTIONS_KEY_SECRET: "directions-secret",
        },
        host: "maps.apigw.ntruss.com",
        body: naverBody(),
      },
      {
        env: { KAKAO_REST_API_KEY: "test-kakao" },
        host: "dapi.kakao.com",
        body: { documents: [{ x: String(point.lng), y: String(point.lat) }] },
      },
      {
        env: { NAVER_MAPS_KEY_ID: "public-web-sdk-key" },
        host: "nominatim.openstreetmap.org",
        body: [
          {
            lat: String(point.lat),
            lon: String(point.lng),
            addresstype: "building",
          },
        ],
      },
    ];
    for (const [index, row] of rows.entries()) {
      const transport = mock(() => json(row.body));
      const lookup = createGeocoder({
        env: row.env,
        fetcher: transport.fetcher,
      });
      assert.deepEqual(
        await lookup(store, "대전 동구 검증로 " + (index + 1)),
        point,
      );
      assert.equal(transport.calls[0].url.hostname, row.host);
      if (index === 0)
        assert.equal(
          transport.calls[0].headers.get("x-ncp-apigw-api-key"),
          "directions-secret",
        );
      if (index === 1)
        assert.equal(
          transport.calls[0].headers.get("Authorization"),
          "KakaoAK test-kakao",
        );
      if (index === 2) {
        assert.equal(
          transport.calls[0].url.searchParams.get("countrycodes"),
          "kr",
        );
        assert.equal(
          transport.calls[0].headers.has("x-ncp-apigw-api-key-id"),
          false,
        );
      }
    }
  });
});

test("일부만 설정한 서버 인증은 다른 인증 정보와 섞거나 공개 검색으로 우회하지 않는다", async () => {
  await temporaryStore(async (store) => {
    for (const env of [
      {
        NAVER_GEOCODING_KEY_ID: "id-only",
        NAVER_DIRECTIONS_KEY_ID: "complete-id",
        NAVER_DIRECTIONS_KEY_SECRET: "complete-secret",
      },
      {
        NAVER_GEOCODING_KEY_SECRET: "secret-only",
        KAKAO_REST_API_KEY: "test-kakao",
      },
      { NAVER_DIRECTIONS_KEY_ID: "id-only" },
    ]) {
      const transport = mock(() => {
        throw new Error("Must not make a provider request");
      });
      await assert.rejects(
        createGeocoder({ env, fetcher: transport.fetcher })(
          store,
          "대전 동구 검증로 1",
        ),
        errorCode("CONFIGURATION", 422),
      );
      assert.equal(transport.calls.length, 0);
    }
  });
});

test("우편번호·공백을 정리하고 첫 검색이 비었을 때만 상세주소를 뺀 도로명·건물번호로 한 번 더 검색한다", async () => {
  await temporaryStore(async (store) => {
    const original =
      "  （３４７０８）  대전 동구 물류로14번길13 (구도동, 예시창고) 2층  ";
    const transport = mock(() =>
      json(
        transport.calls.length === 1
          ? { status: "OK", addresses: [] }
          : naverBody(),
      ),
    );
    const lookup = createGeocoder({
      env: credentials,
      fetcher: transport.fetcher,
    });
    assert.deepEqual(await lookup(store, original), point);
    assert.deepEqual(
      transport.calls.map((call) => call.url.searchParams.get("query")),
      [
        "대전 동구 물류로14번길 13 (구도동, 예시창고) 2층",
        "대전 동구 물류로14번길 13",
      ],
    );
    assert.deepEqual(
      {
        ...store.one<typeof point>(
          "SELECT lat,lng FROM geocodes WHERE address=?",
          original,
        ),
      },
      point,
    );
    assert.equal(
      store.one(
        "SELECT lat,lng FROM geocodes WHERE address=?",
        "대전 동구 물류로14번길 13",
      ),
      undefined,
    );
    assert.equal(
      normalizeGeocodingAddress("우편번호: 34708 대전 동구 물류로14번길 13"),
      "대전 동구 물류로14번길 13",
    );
  });
});

test("도로 숫자·하이픈 건물번호·산 지번을 훼손하지 않으며 두 번 실패하면 임의 위치를 만들지 않는다", async () => {
  await temporaryStore(async (store) => {
    const examples = [
      [
        "서울 강남구 테헤란로 83길 13 (예시동) 2층",
        "서울 강남구 테헤란로 83길 13",
      ],
      [
        "서울 강남구 테헤란로 83 길 13 (예시동) 2층",
        "서울 강남구 테헤란로 83 길 13",
      ],
      [
        "대전 동구 물류로14번길13-2 (구도동) 2층",
        "대전 동구 물류로14번길 13-2",
      ],
      ["대전 동구 구도동 산12-3 (예시창고) 2층", "대전 동구 구도동 산12-3"],
    ];
    for (const [address, expected] of examples) {
      const transport = mock(() => json({ status: "OK", addresses: [] }));
      const lookup = createGeocoder({
        env: credentials,
        fetcher: transport.fetcher,
      });
      await assert.rejects(lookup(store, address), errorCode("NOT_FOUND", 404));
      assert.equal(transport.calls.length, 2);
      assert.equal(transport.calls[1].url.searchParams.get("query"), expected);
      assert.equal(
        store.one("SELECT lat,lng FROM geocodes WHERE address=?", address),
        undefined,
      );
    }
  });
});

test("인증·할당량·서비스 오류를 구분하고 재조회나 숨은 공급자 대체를 하지 않는다", async () => {
  await temporaryStore(async (store) => {
    for (const [status, code, expected] of [
      [401, "AUTHENTICATION", 422],
      [403, "AUTHENTICATION", 422],
      [429, "RATE_LIMIT", 429],
      [500, "UNAVAILABLE", 503],
      [400, "INVALID_ADDRESS", 422],
    ] as const) {
      const transport = mock(() =>
        json({ message: "upstream-internal-details" }, status),
      );
      const lookup = createGeocoder({
        env: { ...credentials, KAKAO_REST_API_KEY: "unused" },
        fetcher: transport.fetcher,
      });
      await assert.rejects(
        lookup(store, "대전 동구 검증로 1 (예시동) 2층"),
        (error: unknown) => {
          assert.ok(error instanceof GeocodingError);
          assert.equal(error.code, code);
          assert.equal(error.status, expected);
          assert.doesNotMatch(
            error.message,
            /위도|경도|upstream-internal-details|test-geocoding-secret/,
          );
          return true;
        },
      );
      assert.equal(transport.calls.length, 1);
    }
  });
});

test("누락·null·빈 값·국외 좌표와 잘못된 JSON 응답을 캐시에 저장하지 않는다", async () => {
  await temporaryStore(async (store) => {
    const bodies = [
      null,
      { status: "OK", addresses: null },
      { status: "FAIL", addresses: [] },
      { status: "OK", addresses: [null] },
      ...[
        { x: null, y: null },
        { x: "", y: "36.3" },
        { x: "127.4" },
        { x: "-122.4", y: "37.8" },
        { x: [], y: "36.3" },
        { x: "0x7f", y: "36.3" },
      ].map((found) => ({ status: "OK", addresses: [found] })),
    ];
    for (const [index, body] of bodies.entries()) {
      const transport = mock(() => json(body));
      const address = "대전 동구 검증로 " + (index + 1);
      await assert.rejects(
        createGeocoder({ env: credentials, fetcher: transport.fetcher })(
          store,
          address,
        ),
        errorCode("INVALID_RESPONSE", 503),
      );
      assert.equal(
        store.one("SELECT lat,lng FROM geocodes WHERE address=?", address),
        undefined,
      );
      assert.equal(transport.calls.length, 1);
    }
    const brokenJson = mock(() => new Response("not-json", { status: 200 }));
    await assert.rejects(
      createGeocoder({ env: credentials, fetcher: brokenJson.fetcher })(
        store,
        "대전 동구 검증로 88",
      ),
      errorCode("INVALID_RESPONSE", 503),
    );
  });
});

test("잘못된 기존 캐시는 새 검색으로 교정하고 유효한 캐시는 외부 인증 없이 재사용한다", async () => {
  await temporaryStore(async (store) => {
    const address = "대전 동구 검증로 12";
    store.run(
      "INSERT INTO geocodes(address,lat,lng) VALUES(?,?,?)",
      address,
      0,
      0,
    );
    const transport = mock(() => json(naverBody()));
    assert.deepEqual(
      await createGeocoder({ env: credentials, fetcher: transport.fetcher })(
        store,
        address,
      ),
      point,
    );
    assert.equal(transport.calls.length, 1);
    const cachedOnly = createGeocoder({
      env: { NAVER_GEOCODING_KEY_ID: "incomplete" },
      fetcher: mock(() => {
        throw new Error("Cache must avoid network");
      }).fetcher,
    });
    assert.deepEqual(await cachedOnly(store, address), point);
  });
});

test("동일한 주소의 동시 요청을 합치고 대기 중 저장된 캐시를 다시 확인한다", async () => {
  await temporaryStore(async (store) => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transport = mock(async () => {
      entered();
      await gate;
      return json(naverBody());
    });
    const lookup = createGeocoder({
      env: credentials,
      fetcher: transport.fetcher,
    });
    const a = "대전 동구 검증로 1",
      alias = "대전  동구 검증로 1",
      b = "대전 동구 검증로 2";
    const first = lookup(store, a),
      same = lookup(store, a),
      normalizedSame = lookup(store, alias);
    await ready;
    const queued = lookup(store, b);
    const cachedPoint = { lat: 36.3, lng: 127.4 };
    store.run(
      "INSERT INTO geocodes(address,lat,lng) VALUES(?,?,?)",
      b,
      cachedPoint.lat,
      cachedPoint.lng,
    );
    release();
    assert.deepEqual(await Promise.all([first, same, normalizedSame, queued]), [
      point,
      point,
      point,
      cachedPoint,
    ]);
    assert.equal(transport.calls.length, 1);
    assert.deepEqual(
      {
        ...store.one<typeof point>(
          "SELECT lat,lng FROM geocodes WHERE address=?",
          alias,
        ),
      },
      point,
    );
  });
});

test("공개 Nominatim 검색은 재검색을 포함해 요청마다 1.1초 간격을 지킨다", async () => {
  await temporaryStore(async (store) => {
    let clock = 0;
    const starts: number[] = [],
      waits: number[] = [];
    const transport = mock(() => {
      starts.push(clock);
      return json(
        starts.length === 1
          ? []
          : [
              {
                lat: String(point.lat),
                lon: String(point.lng),
                addresstype: "building",
              },
            ],
      );
    });
    const lookup = createGeocoder({
      env: {},
      fetcher: transport.fetcher,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    await Promise.all([
      lookup(store, "대전 동구 검증로 1 (예시동) 2층"),
      lookup(store, "대전 동구 검증로 2"),
    ]);
    assert.deepEqual(starts, [0, 1100, 2200]);
    assert.deepEqual(waits, [1100, 1100]);
    assert.match(
      transport.calls[0].headers.get("User-Agent")!,
      /BareunDispatch/,
    );
    const coarse = createGeocoder({
      env: {},
      fetcher: mock(() =>
        json([
          {
            lat: String(point.lat),
            lon: String(point.lng),
            class: "highway",
            addresstype: "road",
          },
        ]),
      ).fetcher,
    });
    await assert.rejects(
      coarse(store, "대전 동구 검증로 99"),
      errorCode("NOT_FOUND", 404),
    );
  });
});

test("연결 또는 응답 본문이 멈춰도 시간 초과 뒤 다음 검색을 정상 처리한다", async () => {
  await temporaryStore(async (store) => {
    for (const phase of ["fetch", "body"]) {
      let hangs = true;
      const transport = mock(() => {
        if (!hangs) return json(naverBody());
        if (phase === "fetch") return new Promise<Response>(() => {});
        return {
          ok: true,
          status: 200,
          json: () => new Promise(() => {}),
        } as Response;
      });
      const lookup = createGeocoder({
        env: credentials,
        fetcher: transport.fetcher,
        requestTimeoutMs: 10,
      });
      const address = "대전 동구 검증로 " + (phase === "fetch" ? 101 : 102);
      await assert.rejects(lookup(store, address), errorCode("TIMEOUT", 408));
      assert.equal(transport.calls[0].signal?.aborted, true);
      hangs = false;
      assert.deepEqual(await lookup(store, address), point);
      assert.equal(transport.calls.length, 2);
    }
  });
});

test("대기열 한도와 대기 시간 초과를 알려 주며 취소된 검색을 뒤늦게 전송하지 않는다", async () => {
  await temporaryStore(async (store) => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transport = mock(async () => {
      if (transport.calls.length === 1) {
        entered();
        await gate;
      }
      return json(naverBody());
    });
    const lookup = createGeocoder({
      env: credentials,
      fetcher: transport.fetcher,
      maxPending: 2,
      queueTimeoutMs: 15,
    });
    const first = lookup(store, "대전 동구 검증로 201");
    await ready;
    const queued = lookup(store, "대전 동구 검증로 202");
    await assert.rejects(
      lookup(store, "대전 동구 검증로 203"),
      errorCode("BUSY", 429),
    );
    await assert.rejects(queued, errorCode("BUSY", 429));
    release();
    await first;
    assert.deepEqual(await lookup(store, "대전 동구 검증로 204"), point);
    assert.equal(transport.calls.length, 2);
    assert.equal(
      store.one(
        "SELECT lat,lng FROM geocodes WHERE address=?",
        "대전 동구 검증로 202",
      ),
      undefined,
    );
  });
});
