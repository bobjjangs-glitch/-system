# 바른배차 클라우드 시작 스킬

## 작업 위치와 보존

이 작업은 이미 격리된 클라우드 환경이다. 기존 `/workspace/-system` 체크아웃을 사용하며, 사용자가 명시적으로 요청하지 않는 한 Git worktree를 만들지 않는다. 작업 전 적용되는 `AGENTS.md`와 `git status --short --untracked-files=all`을 확인한다. 설치·시작만을 위해 앱 소스, 테스트, package.json, 잠금 파일을 변경하거나 기존 사용자 파일을 덮어쓰지 않는다.

이 저장소는 Expo SDK 57·React Native·TypeScript 모바일 앱과 Node.js·SQLite API 서버다. 대전 예시는 선택적으로 관리자 화면에서 생성한다. 기사 수와 기사별 배송지 수는 가변이며, 회사 출발 → 배송지 순회 → 회사 복귀가 기본이다. 자동으로 관리자·기사 계정이나 예시 데이터를 만들지 않는다.

## 도구와 의존성

Node.js 24 LTS(24.3 이상)와 npm을 사용한다. 현재 검증 버전은 Node.js 24.19.0, npm 11.9.0이다. 캐시와 도구는 체크아웃 밖에 둔다.

```bash
cd /workspace/-system
export npm_config_cache=/workspace/.expo-development/npm-cache
export XDG_CACHE_HOME=/workspace/.expo-development/cache
export EXPO_NO_TELEMETRY=1
export NODE_USE_ENV_PROXY=1
```

패키지가 없거나 잠금 파일에 맞춰 새로 설치해야 하면 `bash scripts/install-cloud.sh`를 실행한다. npm 의존성은 `npm ci --no-audit --no-fund`로 설치하며 잠금 파일을 다시 생성하지 않는다. 버전 충돌이 나면 오류를 조사하고 코드 변경은 별도 개발 작업 범위에서 처리한다. 로컬 도구는 `/workspace/.expo-development/tools/node_modules/.bin`에 있다: create-expo-app, expo-doctor, eas. 기존 앱을 재생성하거나 전역 expo-cli를 설치하지 않는다.

현재 선택한 네이티브 개발 대상은 Android 에뮬레이터다. 설치 스크립트는 검증된 JDK 17/21, Android SDK 36·Build Tools 35/36·NDK 27.1·CMake·API 36 x86_64 이미지도 준비한다. 이미 설치된 패키지를 재사용한다. Android 도구만 새로 준비할 때는 `python3 scripts/setup-cloud-android.py --with-emulator`를 실행한다. 웹 작업만 할 때는 `BAREUN_PREPARE_ANDROID=0`으로 선택할 수 있다. 상세 절차는 `docs/ANDROID_DEVELOPMENT.md`를 따른다.

## API 서버 시작과 확인

스냅샷은 파일과 설치한 의존성을 보존하지만 프로세스를 보존하지 않는다. 먼저 서버 상태를 로컬 요청으로 확인한다. 이미 실행 중이면 프로세스의 작업 디렉터리·데이터 디렉터리가 이 앱과 맞는지 확인하고 재사용한다. 관련 없는 포트 점유 프로세스를 종료하지 않는다.

별도 지속 터미널에서 다음을 실행한다. 개발 중 파일 변경 시 서버가 다시 시작된다.

```bash
cd /workspace/-system
export APP_DATA_DIR=/workspace/.expo-development/data
export PORT=4000
npm run server:dev
```

다른 터미널에서 `curl --fail --silent --show-error http://127.0.0.1:4000/api/health`를 실행한다. 응답의 `ok`가 true이고 `service`가 `bareun-dispatch`여야 한다. PID·열린 포트만으로 준비됐다고 판단하지 않는다. 개발 계정·전표·SQLite 파일을 초기화하지 않는다. `APP_DATA_DIR`의 DB, session.key, uploads/를 함께 보존한다.

## Expo 개발 서버 시작과 확인

현재 목표는 Expo 개발 빌드다. 먼저 아래 Android 빌드·설치 절차를 수행하고 APK가 실제 설치된 뒤 Metro를 별도 지속 터미널에서 실행한다. CI 모드는 Metro의 변경 감지를 끄므로 이 프로세스에서는 CI 변수를 제거한다. 오프라인 설정은 설치한 SDK의 번들을 실행하기 위한 기본값이며, 주소 검색 같은 백엔드 요청의 성공을 뜻하지 않는다.

각 터미널에서 `source scripts/cloud-android-env.sh`로 JDK·SDK·Gradle 경로를 활성화한다. 이 환경은 KVM 가속이 없으므로 `docs/ANDROID_DEVELOPMENT.md`의 headless 소프트웨어 모드로 `Bareun_API_36`을 시작한다. 기존 관련 가상 기기가 실행 중이면 재사용하고, 다른 기기는 종료하지 않는다. `adb devices -l`과 `adb -s emulator-5554 shell getprop sys.boot_completed`의 1을 확인한다. 가상 기기 부팅은 확인했지만 APK 설치는 아직 완료되지 않았다.

네이티브 프로젝트가 없거나 네이티브 의존성·앱 설정을 변경해 재생성이 필요하면 사용자 변경을 보존한 뒤 `npx expo prebuild --clean --platform android`를 실행한다. 네이티브 설정이 그대로라면 clean을 반복하지 않는다. 재생성 후 `python3 scripts/setup-cloud-android.py --with-emulator`로 Gradle 공식 배포 체크섬을 설정한다. 빌드·설치는 다음 명령을 사용한다.

```bash
cd /workspace/-system
source scripts/cloud-android-env.sh
NODE_ENV=development EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 npx expo run:android --device Bareun_API_36 --no-bundler
```

현재 명령은 필수 `react-android-0.86.3-debug.aar` 다운로드가 `repo.reactnative.dev`에서 403으로 차단되어 실패했다. 이 도메인 요구사항은 초안에 저장했다. 실제 실행 환경에 허용이 적용되었는지 확인한 뒤 영향을 받은 단계만 재실행하고 유효한 Gradle 캐시를 보존한다. APK 생성·설치를 성공했다고 주장하지 않는다. iOS 컴파일은 선택되지 않았으며 Mac·Xcode 환경이 별도로 필요하다.

APK가 설치되면 ADB로 개발용 로컬 API와 Metro 포트를 연결하고 개발 서버를 시작한다.

```bash
cd /workspace/-system
source scripts/cloud-android-env.sh
adb -s emulator-5554 reverse tcp:4000 tcp:4000
adb -s emulator-5554 reverse tcp:8081 tcp:8081
env -u CI EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 EXPO_PUBLIC_API_URL=http://127.0.0.1:4000 npx expo start --dev-client --localhost --port 8081
```

Expo Go로 공통 JavaScript 화면만 확인하는 별도 작업이라면 `npm run start:go -- --localhost --port 8081`을 사용할 수 있지만, 이를 개발 빌드의 네이티브 기능 검증으로 취급하지 않는다. Expo Go·개발 빌드·배포 앱은 같은 API 서버를 사용할 수 있다.

`--offline`과 `--localhost` 플래그는 동시에 쓰지 않는다. 위처럼 환경 변수로 오프라인 모드를 설정한다. 이 온보딩 UI에서는 localhost 웹 미리보기나 링크를 만들지 않는다. 내부 요청으로만 검증한다.

```bash
curl --fail --silent --show-error http://localhost:8081/status
curl --fail --silent --show-error --max-time 120 'http://localhost:8081/node_modules/expo/AppEntry.bundle?platform=android&dev=true&minify=false' -o /workspace/.expo-development/android-development.bundle
```

첫 응답은 `packager-status:running`, 두 번째는 HTTP 성공과 비어 있지 않은 실제 JavaScript 번들이어야 한다. 브라우저 확인용 웹 빌드가 필요하면 `npm run export:web` 후 API 서버를 재시작한다. 서버가 `dist/`의 웹앱을 제공한다.

## 코드·번들 검증

```bash
cd /workspace/-system
npm run typecheck
npm test
EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 CI=1 npm run export:mobile -- --output-dir /workspace/.expo-development/exports/mobile
```

테스트는 임시 DB를 사용한다. 실제 개발 DB에 임의 계정·PIN을 넣지 않는다. 실패·건너뜀·미실행을 구분하고, 테스트 개수와 완료 상태를 확인한다. 모바일 export는 iOS·Android 번들 검증이며 서명된 APK·IPA 생성이나 기기 GPS 검증이 아니다.

온라인 진단은 `NODE_USE_ENV_PROXY=1 /workspace/.expo-development/tools/node_modules/.bin/expo-doctor --verbose`로 실행한다. 현재 인스턴스에서는 네트워크 정책 때문에 21개 중 19개가 통과했고, Expo 설정 스키마·React Native Directory 외부 조회 2개가 차단되었다. 필요한 도메인은 환경 초안에 저장했다. 사용자가 설정을 적용한 뒤 현재 정책을 확인하고 이 진단, 주소 검색과 도로 경로 요청을 다시 검증한다. 네트워크 오류를 무시하는 옵션으로 통과 처리하지 않는다.

## 실제 휴대폰·사내 배포 조건

이 앱의 직원용 배포는 `eas.json`의 `internal` 프로필을 사용한다. Android는 APK, iPhone은 등록된 기기용 Ad Hoc 방식이다. 스토어 제출은 하지 않는다. Expo 계정 연결과 HTTPS 백엔드가 필요하며, iPhone은 Apple Developer 유료 계정과 기기 등록이 추가로 필요하다. 현재 Apple 계정은 없으므로 서명·설치를 완료했다고 주장하지 않는다. 배포·로그인·유료 빌드를 자동 실행하지 않는다. 절차는 `docs/INTERNAL_DISTRIBUTION.md`를 따른다.

휴대폰 빌드 전에 실제 접근 가능한 서버 주소를 `EXPO_PUBLIC_API_URL`에 설정한다. 비밀 값을 앱에 넣지 않으며 키가 필요하면 기존 환경의 이름·존재·준비 상태만 점검하고 보안 설정을 이용한다. 기본 주소 검색은 키 없는 Nominatim이며, 선택적으로 서버의 KAKAO_REST_API_KEY를 사용한다. 인쇄 전표의 한글 OCR 모델은 npm으로 설치한 로컬 파일을 사용한다.

백그라운드 위치 공유는 자체 설치 앱과 사용자 권한이 필요하다. Expo Go·웹의 전경 위치 검증과 구분한다. 마지막 수신 위치를 현재 위치로 가장하거나 좌표·배송 결과를 임의 생성하지 않는다. 실제 휴대폰에서 길안내 앱 전환, 백그라운드 갱신, 회사 복귀 후 수집 중단을 확인한다.

## 무료 Node.js 테스트 서버

사용자는 유료 서버를 신청하기 전에 무료 Node.js 테스트를 요청했다. `render.yaml`은 Render의 `free` Web Service 하나만 선언한다. 유료 서버·DB·디스크를 추가하지 않는다. `docs/FREE_NODE_TEST.md`와 `deploy/render/build.sh`, `deploy/render/start.sh`를 따른다. 무료 테스트만 진행할 때 Android SDK 설치나 실패한 APK 빌드를 반복하지 않는다. 기존 개발 API는 재사용한다.

별도 복사본에서 Render용 설치·웹 export·운영 의존성 정리·실제 시작 명령을 실행했다. 임시 데이터로 최초 등록 보호·로그인, 기사 5명·대전 배송지 25곳·왕복 코스 5개, 실제 한글 전표 OCR과 검토 후 등록 보호, 인증된 WebSocket 연결을 확인했다. 원본 소스·잠금 파일·개발 DB는 보존했다. 외부 경로 서비스 차단에 따라 예상 시간은 approximate로 확인했다. 이 결과는 실제 Render 배포나 무료 서버 메모리 한도 검증을 뜻하지 않는다.

현재 실행 환경은 Render와 공개 임시 주소 서비스에 403을 반환한다. 연결된 Render 인증이나 공개 포트 기능도 없다. 필요한 Render 도메인과 RENDER_API_KEY 보안 연결 요구사항은 환경 설정 초안에 추가한다. 준비 상태와 실제 접근을 확인하고 기존 바인딩을 사용하며 API 키를 출력하지 않는다. 계정·네트워크가 준비되면 실제 배포 상태와 외부 HTTPS·WebSocket을 검증한다. 브라우저 로그인만으로 API 인증이 제공된다고 가정하지 않는다. SQLite·전표·계정은 무료 서버 재시작·재배포 시 사라질 수 있으므로 예시 데이터만 사용한다. 백그라운드 위치는 별도 네이티브 기기 검증이 필요하다.

앱 소스와 무료 배포 설정의 브랜치는 `codex/free-node-test`다. 사용자는 앱 전체 소스를 기존 `bobjjangs-glitch/-system` 저장소의 이 브랜치로 업로드해도 되는지 묻는 요청에 `업로드해줘`라고 명시적으로 승인했다. 이 범위의 승인을 반복해서 묻지 않는다. 기존 플랫폼 Git 인증을 사용해 해당 브랜치를 업로드하고, 원격 브랜치 커밋이 로컬 HEAD와 일치하는지 확인한다. GitHub 업로드와 Render 서버 배포는 별개로 검증한다.

Render Blueprint 생성 화면에서는 Blueprint Name `systemfile`, Branch `codex/free-node-test`, Blueprint Path `render.yaml`을 사용한다. `main`의 README만 읽어서는 앱을 배포할 수 없다. 사용자가 Path에 `README.md`를 입력했을 때 `EOF` 오류가 났으므로 이 값을 배포 설정 파일 경로로 안내한다. 이 대화에는 열린 사용자 브라우저를 클릭하는 기능이 없으므로 브라우저 조작을 했다고 주장하지 않는다.

## 최신 우선 목표: LDPlayer 설치용 APK

사용자가 APK·IPA 제작을 요청한 뒤 LDPlayer에 설치할 APK를 먼저 달라고 지정했다. 기본 작업은 LDPlayer 9의 64비트 Android를 위한 x86_64 테스트 APK다. 위 클라우드 AVD·개발 빌드·Metro 시작 절차는 별도의 개발 테스트 요청에 사용하며 이 목표를 위해 반복하지 않는다. 현재 API 주소는 https://bareun-dispatch-test.onrender.com 이다.

`eas.json`의 `ldplayer` 프로필을 공식 eas-json 파서로 검증했고 현재 Android Hermes 번들 export도 통과했다. `bash scripts/build-ldplayer-apk.sh`는 release 모드로 JS를 포함하고, 실제 APK 생성·서명 검증이 성공한 경우에만 artifacts 폴더에 테스트 APK를 복사한다. 현재 생성된 APK는 없다. 번들·ZIP을 설치 파일로 잘못 제공하지 않는다.

공식 React Native release AAR 다운로드는 Maven Central에서 repo.reactnative.dev로 이동해 실행 환경의 CONNECT 403으로 막혔다. 도메인은 설정 초안에 있으나 실행 허용 목록에는 미적용이다. 접근 허용이 실제 반영된 뒤 로컬 APK 빌드를 이어서 실행한다. Gradle 캐시와 SDK를 보존하고 프록시·TLS·체크섬 검증을 우회하지 않는다. 로컬 Android 빌드에는 Expo 로그인이 필요 없다. `eas whoami`는 Not logged in을 반환했으므로 클라우드 빌드는 별도 인증이 필요하다. IPA는 Android 다음 순서이며 Apple Developer 계정과 등록 기기·서명이 필요하다.
