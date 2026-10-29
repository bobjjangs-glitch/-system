# 카페24 DEV B 서버 설치

사용자가 제공한 신청 화면의 상품은 Ubuntu 24.04 LTS, Node.js 24, Express 5, PM2, Nginx를 제공하는 개발언어 VPS DEV B입니다. 아래 파일은 그 환경에 맞춘 배포 예시입니다. 현재 실제 카페24 서버에 접속하거나 배포한 상태는 아닙니다. 실제 접속 정보·권한·기존 PM2/Nginx 설정을 확인한 뒤 적용합니다.

## 1. 개통 후 확인할 정보

카페24의 나의서비스관리에서 서버 공인 IP, SSH/SFTP 포트, 접속 계정, 기본 도메인 또는 사용할 도메인을 확인합니다. 접속 정보 화면은 비밀번호·개인키·인증번호 부분을 가린 상태로 공유할 수 있습니다. 비밀번호·개인키는 채팅이나 앱 저장소에 넣지 않습니다.

서버 설치 작업자는 SSH/SFTP 접근과 앱 폴더 쓰기, PM2 설정, 해당 사이트의 Nginx 설정 권한이 필요합니다. 카페24가 제공한 프로젝트 경로와 계정 권한을 먼저 확인합니다. 다른 사이트나 기본 Express 샘플을 확인 없이 삭제하지 않습니다.

## 2. 업로드

현재 앱 소스는 GitHub의 main에 반영되지 않은 로컬 변경도 포함하므로, 기존 원격 저장소를 clone하는 것만으로 새 앱이 올라가지 않습니다. 준비한 배포 ZIP을 사용하거나 앱 코드를 먼저 저장소에 반영한 후 배포합니다.

ZIP 내부 최상위 폴더는 `dispatch/`입니다. 실제 프로젝트가 `/opt/bareun_dispatch`일 때 SFTP로 ZIP을 그 폴더에 올리고 압축을 해제하면 다음과 같이 배치합니다. 이미 동일한 앱 폴더가 있다면 이전 배포본을 보존하고 업데이트합니다.

```text
/opt/bareun_dispatch/
  dispatch/              앱 코드와 이미 빌드한 관리자 웹 화면
    package.json
    package-lock.json
    server/
    dist/
    deploy/cafe24/
  shared/                앱 업로드·교체와 별도로 보관
    server.env           운영 설정·최초 관리자 등록 코드 (소유자만 읽기)
    data/                SQLite·session.key·전표 원본
```

서버의 실제 프로젝트 폴더가 다르면 위 경로와 아래 `DISPATCH_SHARED_DIR`을 실제 경로로 맞춥니다. `node_modules`, 개발용 DB·업로드 사진·로그, `.git`, 실제 비밀 설정 파일은 배포 ZIP에 포함하지 않습니다.

## 3. 의존성·운영 설정

SSH 터미널에서 실제 업로드 경로로 이동합니다. 아래 명령은 서버 개통 후 실행할 명령이며 이 클라우드에서 카페24에 자동 적용되지는 않습니다.

```bash
cd /opt/bareun_dispatch/dispatch
node --version
npm ci --omit=dev --no-audit --no-fund
```

Node.js는 현재 앱이 요구하는 24 LTS의 최신 패치 버전을 사용합니다. `npm start`는 Expo 개발 서버 명령입니다. 운영에서는 아래 PM2 설정을 사용합니다. ZIP에는 빌드된 `dist/` 웹 화면이 포함되어 있어 서버에서 다시 모바일·웹을 빌드할 필요가 없습니다.

실제 사용할 HTTPS 주소로 환경 파일을 생성합니다. 예시 도메인 문구를 그대로 쓰지 않습니다.

```bash
node deploy/cafe24/prepare-env.mjs https://실제접속도메인
```

기존 `shared/server.env`가 있으면 덮어쓰지 않습니다. 최초 실행은 서버 안에서 관리자 등록 코드를 생성해 권한 600의 비공개 환경 파일에 저장하며 로그에 값을 출력하지 않습니다. 서버 소유자가 해당 파일을 비공개로 열어 최초 관리자 등록 화면에 코드를 입력합니다.

현재 앱은 SQLite를 사용합니다. 카페24가 PostgreSQL을 자동 설치했더라도 앱을 PostgreSQL에 자동 연결하지 않습니다. 서버 DB·세션 키·전표 파일은 `shared/data` 전체를 함께 보존·백업합니다.

## 4. PM2 자동 실행

기존 카페24 샘플 앱의 이름·사용 포트를 확인합니다. 준비한 PM2 앱 이름은 `bareun-dispatch`, API 포트는 로컬 4000입니다. 4000 포트가 다른 서비스에서 사용 중이면 그 서비스를 임의로 종료하지 말고 앱 포트와 Nginx 연결을 함께 조정합니다.

```bash
cd /opt/bareun_dispatch/dispatch
pm2 startOrRestart deploy/cafe24/ecosystem.config.cjs
pm2 save
curl --fail --silent --show-error http://127.0.0.1:4000/api/health
```

응답의 `ok`가 true이고 `service`가 `bareun-dispatch`인지 확인합니다. `pm2 list` 또는 열린 포트만으로 성공이라고 판단하지 않습니다. 사용자 지정 shared 경로를 썼다면 PM2 시작 전에 `DISPATCH_SHARED_DIR`을 그 경로로 설정합니다.

서버 재부팅 후 PM2 복구는 카페24의 기존 자동 시작 설정을 확인해 적용합니다. 설정이 없다면 해당 서비스 계정에서 `pm2 startup`이 안내하는 운영체제 등록 절차를 수행하고 `pm2 save`를 확인합니다. 다른 계정·서비스의 PM2 목록을 덮어쓰거나 전체 서비스를 삭제하지 않습니다.

## 5. Nginx·HTTPS

해당 도메인의 기존 Nginx `server` 블록에 `deploy/cafe24/nginx-location.conf`를 반영합니다. 기존 샘플 앱의 루트 location을 교체하는 예시이므로 다른 사이트까지 통째로 덮어쓰지 않습니다. 업로드는 15MB 이하를 앱이 허용하고 Nginx는 multipart 여유를 포함해 16MB로 설정합니다. `/live`는 기사 위치 갱신용 WebSocket 연결입니다.

앱은 127.0.0.1에만 바인딩하고, 로컬 Nginx가 전달하는 클라이언트 주소만 신뢰하도록 설정합니다. Nginx는 외부가 보낸 전달 헤더를 그대로 이어 붙이지 않고 실제 연결 주소로 덮어씁니다.

```bash
sudo nginx -t
sudo systemctl reload nginx
```

위 명령은 Nginx를 직접 관리할 수 있는 계정 기준입니다. 카페24 관리 화면만 허용되는 구조라면 제공된 사이트 설정 방식으로 반영합니다. HTTPS 인증서는 실제 도메인의 DNS와 무료 인증서 적용 가능 여부를 확인한 뒤 구성합니다. 인증서 설치까지 끝나야 직원 휴대폰에서 사용할 실제 주소가 준비됩니다. 외부에는 웹용 80·443을 열고 SSH는 관리용으로 제한하며 4000은 로컬용으로 유지합니다.

## 6. 개통 확인과 초기 등록

실제 HTTPS 주소에서 `/api/health`, 첫 관리자 등록, 관리자 로그인, 사진·엑셀 업로드, 주소 검색, 배차, 기사 로그인, 실시간 위치 연결을 확인합니다. 회사의 실제 출발·복귀 주소와 기사 PIN을 등록합니다. 예시 데이터를 썼다면 실제 배송 전 지웁니다.

그 다음 휴대폰 앱 빌드 환경에 `EXPO_PUBLIC_API_URL`로 이 HTTPS 주소를 넣어 Android APK와 iPhone 내부 설치 파일을 생성합니다. 앱 서버 설치와 휴대폰 설치 파일 생성은 별도 단계입니다. iPhone은 Apple Developer 가입·기기 등록이 선행되어야 합니다. 실제 기기에서 길안내 앱 전환 후 위치 갱신, 배송 완료·미배송·회사 복귀와 위치 공유 중단을 확인합니다.

## 업데이트

이전 앱 배포본을 보존한 뒤 코드와 `dist/`를 교체하고, 잠금 파일에 맞춰 의존성을 설치한 후 해당 PM2 앱만 재시작합니다. `shared/server.env`, `shared/data`는 코드 교체 대상으로 삼지 않습니다. DB·session.key·업로드 파일을 함께 백업하고 복구 가능성을 확인합니다.
