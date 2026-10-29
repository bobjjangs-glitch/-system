# 바른배차

대전 지역의 소규모 배송팀을 위한 Expo·React Native 앱입니다. Android·iPhone 공용 화면과 Node.js·SQLite 서버를 제공합니다. 스토어 공개 없이 사내 설치 파일로 배포하도록 구성했습니다.

## 사용하는 순서

1. 처음 접속한 관리자가 이름과 숫자 6~12자리 PIN을 등록합니다. 배포 서버에서는 최초 등록 코드도 필요합니다.
2. `현황 → 대전 예시 데이터로 둘러보기`로 기사 5명·배송지 25곳을 살펴볼 수 있습니다. 예시 기사 PIN은 발급 화면과 관리자 `기사 → PIN 보기`에서 확인할 수 있습니다. 실제 운영 전에 `회사 설정 → 예시 데이터 전체 삭제`로 지우세요.
3. `회사 설정`에서 회사명, 출발·복귀 주소, 좌표, 배송지 체류 시간과 길안내 앱을 설정합니다.
4. `기사`에서 기사를 추가하고 PIN을 발급합니다. 관리자만 기사별 `PIN 보기`로 현재 PIN을 다시 확인할 수 있으며 조회만으로 기존 PIN을 변경하지 않습니다. 이전 버전 계정은 해당 기사가 한 번 정상 로그인하거나 새 PIN을 발급한 뒤 조회할 수 있습니다. 기사 수와 기사별 최대 배송지 수를 늘릴 수 있습니다.
5. `전표`에서 사진을 촬영·선택하거나 엑셀(.xlsx·.csv)을 업로드합니다. 인식된 주소·물품·수량을 원본과 확인하고 좌표 검색 후 등록합니다. 인식 결과는 확인 전에 자동 등록되지 않습니다.
6. `배차`에서 추천 코스를 생성합니다. 가까운 배송지를 기사별 한도 안에서 묶고, 회사 왕복 경로의 순서를 개선합니다. 출발 전에는 순서와 담당 코스를 조정할 수 있습니다.
7. 기사는 자신의 PIN으로 로그인해 물품을 확인합니다. `코스 출발`로 운행·위치 공유를 시작하고 첫 배송지 길안내를 엽니다. 배송 완료 후 다음 배송지, 마지막 배송 후 회사 길안내로 이어집니다. `회사 도착 · 복귀 완료`로 위치 공유를 끝냅니다.
8. 관리자는 기사 위치, 처리 상태, 물품, 업로드 원본과 날짜별 배송 내역을 확인합니다. 미배송은 사유와 함께 별도 기록됩니다.

## 개발 환경

Android 개발 빌드의 설치·clean prebuild·도구 활성화·에뮬레이터 절차는 [Android 개발 빌드 안내](docs/ANDROID_DEVELOPMENT.md)에 있습니다. Expo Go·개발 빌드·배포 앱은 같은 API 서버를 사용할 수 있습니다.

Node.js 24 LTS(24.3 이상), npm을 사용합니다. 잠금 파일을 유지한 설치는 다음과 같습니다.

```bash
cd /workspace/-system
bash scripts/install-cloud.sh
```

서버와 Metro는 별도 터미널에서 실행합니다. 이 클라우드 작업은 이미 격리되어 있으므로 기존 체크아웃을 사용하고 새 Git worktree를 만들지 않습니다.

```bash
cd /workspace/-system
APP_DATA_DIR=/workspace/.expo-development/data npm run server:dev
```

```bash
cd /workspace/-system
env -u CI EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 npm start -- --go --localhost --port 8081
```

위 Metro 명령은 Expo Go 화면 확인용입니다. Android 개발 빌드를 설치한 뒤에는 `npx expo start --dev-client`를 사용하며, 네이티브 빌드·도구 활성화 절차는 Android 개발 빌드 안내를 따릅니다.

상세한 재시작·검증 절차는 [시작 스킬](docs/START_SKILL.md)에 있습니다. 메모리에 살아 있는 프로세스는 환경 스냅샷으로 복원되지 않습니다.

```bash
npm run typecheck
npm test
npm run export:mobile -- --output-dir /workspace/.expo-development/exports/mobile
npm run export:web
```

`export:mobile`은 Android·iOS의 Hermes 번들을 검증하며 APK·IPA 설치 파일을 만드는 명령은 아닙니다. 웹 빌드 후 서버를 재시작하면 서버가 관리자·기사 웹 화면도 제공합니다. 클라우드 온보딩에서는 별도의 웹 미리보기 링크를 만들지 않습니다.

## 주소·지도·예상 시간

- 기본 주소 검색: OpenStreetMap Nominatim. 요청을 직렬화하고 초당 1회 이하로 제한하며 결과를 캐시합니다.
- 선택 주소 검색: 서버에 `KAKAO_REST_API_KEY`가 있으면 카카오 주소 검색을 사용합니다. 키를 앱에 넣지 않습니다.
- 도로 경로·시간: OSRM. 계산에 회사 복귀와 배송지 체류 시간을 포함합니다. 실시간 교통을 반영하지 않으며 전역 최적해를 보장하지 않습니다.
- 도로 서비스에 연결되지 않으면 직선거리 기반의 대략적 예상임을 화면에 표시합니다. 점선은 실제 도로 경로가 아닙니다.
- 주소를 찾지 못하면 잘못된 좌표를 만들지 않습니다. 주소 수정 또는 좌표 직접 입력 후 배차합니다.
- 지도 타일: OpenStreetMap. 지도·주소·경로 서비스는 네트워크 접근이 필요합니다.

클라우드 환경 설정 초안에 필요한 도메인을 추가했습니다: `api.expo.dev`, `exp.host`, `reactnative.directory`, `docs.expo.dev`, `nominatim.openstreetmap.org`, `router.project-osrm.org`, `tile.openstreetmap.org`, `dapi.kakao.com`. 초안 저장은 현재 네트워크에 즉시 적용되지 않습니다. 환경 설정에서 검토·저장하고 환경을 게시한 뒤 온라인 진단과 주소 검색을 다시 확인하세요.

## 실제 휴대폰과 사내 배포

카페24 DEV B 신청 후 서버 업로드·운영 설정은 [카페24 서버 설치 안내](docs/CAFE24_DEPLOYMENT.md)를 따릅니다. PM2 설정, 운영 환경 파일 생성 도구와 Nginx 연결 예시가 포함되어 있습니다. 배포 ZIP은 웹 빌드 후 `python3 scripts/package-cafe24.py`로 만들 수 있습니다.

[사내 설치 안내](docs/INTERNAL_DISTRIBUTION.md)에 Android APK와 iPhone Ad Hoc 설치 절차를 정리했습니다. `eas.json`의 `internal` 프로필을 사용하며 스토어 제출 설정은 없습니다.

실제 휴대폰에서 접근 가능한 HTTPS 서버를 준비하고, 앱을 빌드하기 전에 `EXPO_PUBLIC_API_URL`을 그 서버 주소로 설정해야 합니다. 클라우드의 내부 개발 포트는 직원 휴대폰에서 바로 접근할 수 있는 서버 주소가 아닙니다. 설치 파일 배포와 서버 운영은 별개입니다.

배송 중 다른 길안내 앱으로 전환한 뒤에도 위치를 받으려면 자체 설치한 네이티브 앱에서 백그라운드 위치 권한을 허용해야 합니다. Expo Go·웹 또는 권한이 없는 경우는 화면을 열어 둔 동안의 위치 공유만 지원합니다. Android 알림·배터리 제한, iOS 위치 권한과 실제 기기 동작을 출고 전에 확인해야 합니다. 수신하지 않은 위치를 실시간 위치로 표시하지 않습니다.

## 데이터와 접근

서버 데이터는 `APP_DATA_DIR` 아래의 SQLite DB, `session.key`, `uploads/`에 저장됩니다. 클라우드 기본 위치는 저장소 밖 `/workspace/.expo-development/data`입니다. 이 디렉터리를 영구 디스크로 보존하고 세 항목을 함께 백업하세요. 로그인은 PIN 해시로 검증하고, 기사 PIN은 관리자 조회를 위해 AES-GCM 암호문으로도 보관합니다. 관리자 PIN은 복원 가능한 형태로 저장하지 않습니다. 기사 PIN 암호화 키는 `session.key`에서 별도로 유도하므로 키 파일도 반드시 보존해야 합니다. 로그인 세션은 7일 후 만료되고 PIN 재발급·기사 비활성화 시 취소합니다. 위치 이력은 30일간 보관합니다.

운영 서버에서는 `NODE_ENV=production`, 회사 웹앱 출처를 담은 `CORS_ORIGINS`, 안전한 최초 등록 코드 `DISPATCH_BOOTSTRAP_TOKEN`을 설정하세요. 등록 코드는 서버의 보안 환경 설정에서 공급하고 저장소·앱·채팅에 넣지 않습니다. HTTPS와 필요 시 회사 VPN으로 직원 휴대폰의 접근을 제한할 수 있습니다. SQLite·전표 파일과 서명 키는 공개 정적 폴더에 두지 않습니다.

## 검증 범위

자동 테스트는 PIN·역할별 권한, 전표의 검토 후 등록과 중복 방지, 엑셀·CSV, 실제 한글 OCR 이미지, 기사 수용량, 회사 왕복 경로, WebSocket 위치 전달, 미배송과 복귀 전환, PIN 변경 후 세션 취소를 확인합니다. 실제 휴대폰의 GPS·카메라·백그라운드 실행 및 설치 파일 서명은 물리 기기와 배포 계정이 필요한 별도 검증입니다.
