# 무료 Node.js 테스트

`render.yaml`은 Render Web Service의 `free` 플랜을 선택한다. Node.js 24에서 기존 Express API와 Expo 웹 화면을 함께 실행한다. 별도 데이터베이스·유료 디스크·유료 서버를 생성하는 설정은 없다. Expo Go와 자체 개발 빌드도 이 API를 사용할 수 있다.

이 설정은 예시 데이터로 기능을 확인하는 용도다. 무료 서버가 재시작되거나 재배포되면 SQLite DB, 기사 PIN, 로그인, 전표 사진과 배송 내역이 삭제될 수 있다. 유휴 상태에서 서비스가 정지되어 첫 접속이 늦어질 수 있고, 사진 OCR은 무료 플랜의 메모리 제한으로 실패할 수 있다. 실제 회사 전표와 위치 이력을 보관하는 운영 서버로 사용하지 않는다. 현재 요금·이용 가능 여부는 배포 화면에서 `Free`와 예상 비용을 확인한다.

## 배포 순서

1. 최신 앱 소스와 루트의 `render.yaml`, `deploy/render/`를 GitHub 저장소의 배포할 브랜치에 올린다. 이 앱의 배포 브랜치는 `codex/free-node-test`다. 기존 GitHub `main`에 README만 있다면 연결만으로 앱을 배포할 수 없다. 제공 ZIP의 `dispatch/`가 저장소 루트가 되어야 한다.
2. Render에 로그인하고 GitHub 저장소 접근을 연결한다. `New → Blueprint`에서 저장소 `bobjjangs-glitch/-system`, Branch `codex/free-node-test`, Blueprint Path `render.yaml`을 선택한다. Blueprint Name은 `systemfile`을 사용할 수 있다. `README.md`는 소개 문서이므로 Blueprint Path로 넣으면 설정을 읽지 못한다. 서비스 플랜이 `Free`인지 확인한다. 자동 배포는 꺼져 있다.
3. 생성 후 빌드·시작 로그와 상태 검사 성공을 확인한다. Render가 제공하는 실제 HTTPS 서비스 주소가 생겨야 외부 접속이 완료된 것이다. 파일 생성이나 로컬 테스트 성공만으로 배포가 완료되지는 않는다.
4. Render 서비스의 보안 환경 변수 화면에서 자동 생성된 `DISPATCH_BOOTSTRAP_TOKEN`을 확인한다. 채팅·GitHub·앱 설정에 복사하지 않는다. 앱의 최초 관리자 등록 화면에서만 등록 코드로 사용하고, 본인이 정한 관리자 PIN을 등록한다.
5. 관리자 `현황 → 대전 예시 데이터로 둘러보기`로 기사 5명·배송지 25곳을 만든다. 기사 PIN은 발급 화면에서 확인한다. 회사 설정에서 회사 출발·복귀 주소를 바꾸고 코스 생성·전표 업로드·배송 처리·내역을 확인한다.

공개 접속을 확인할 항목은 웹 화면, `/api/health`의 `ok: true`, 관리자 등록 후 로그인, 배차, 인증된 WebSocket 위치 수신이다. 서비스가 초기화되어 로그인되지 않으면 최초 등록 화면부터 다시 시작한다. 등록 코드는 환경 변수로 유지되지만 SQLite의 계정과 내역은 유지된다고 가정하지 않는다.

관리자는 `기사 → PIN 보기`에서 기사별 현재 PIN을 확인할 수 있다. 기존 계정의 복원 가능한 PIN 정보가 없으면 기사가 한 번 정상 로그인하거나 관리자가 새 PIN을 발급한 뒤 조회한다. 재배포로 계정이 사라진 경우 새 버전 앱은 로그인 실패·세션 만료 후 최초 등록 상태를 다시 조회한다. 이전 화면에서 PIN 입력란만 남아 있으면 `연결 상태 다시 확인`을 누른다. 이 처리는 삭제된 계정·배송 내역을 복구하는 기능은 아니다.

## Expo Go에서 연결

휴대폰이 실제로 접속할 수 있는 Render HTTPS 주소를 사용한다. 프로젝트를 실행할 PC에서 `EXPO_PUBLIC_API_URL`에 그 주소를 설정하고 `npm run start:go`로 시작한다. Windows PowerShell의 예시는 다음과 같다. 꺾쇠괄호 부분을 실제 발급 주소로 바꾼다.

```powershell
$env:EXPO_PUBLIC_API_URL = 'https://<발급된-서비스명>.onrender.com'
npm run start:go
```

API 주소는 비밀 값이 아니며, 관리자 등록 코드와 서버 API 키를 `EXPO_PUBLIC_*`에 넣으면 안 된다. 웹 화면은 같은 서비스 주소로 API에 연결하므로 별도 API 주소를 번들에 넣지 않는다.

Expo Go는 iOS·Android에서 화면·전표·배차·전경 위치를 테스트하는 용도다. 길안내 앱으로 전환한 뒤의 백그라운드 위치는 자체 개발 빌드와 실제 기기에서 별도로 확인해야 한다. Render의 API 배포는 Android APK 컴파일과 별개다.

## 이 클라우드에서의 상태

- 기존 Node.js 개발 API의 정상 응답을 확인했다.
- Render용 `npm ci`·웹 빌드·운영 의존성 정리와 실제 시작 명령을 별도 디렉터리에서 실행해 통과했다. package.json·잠금 파일이 바뀌지 않았고, 기존 개발 DB도 초기화하지 않았다.
- 임시 데이터로 웹 HTML·실제 JS 번들, 등록 코드 없는 관리자 생성 거부, 정상 등록·PIN 로그인, 기사 5명·배송지 25곳·왕복 코스 5개, 실제 한글 이미지 OCR과 검토 전 미등록, 인증된 WebSocket 연결을 확인했다. 도로 서비스가 차단되어 경로 시간은 `approximate`로 표시되는 것도 확인했다. 실제 Render 서버의 자원 제한·외부 접속·휴대폰 GPS 검증은 남아 있다.
- 사용자가 Render에서 배포한 서비스 주소는 `https://bareun-dispatch-test.onrender.com`이다. 이 클라우드의 해당 주소 접속은 네트워크 정책에서 CONNECT 403으로 차단되어 직접 상태 검증은 남아 있다. 연결된 Render 관리 API 인증과 사용자 브라우저 조작 기능도 없다.
- 앱과 무료 배포 설정은 `codex/free-node-test` 브랜치에 정리했다. 사용자가 앱 전체 소스를 기존 GitHub 저장소의 해당 브랜치에 올리는 요청에 `업로드해줘`라고 명시적으로 승인했다. 원격 업로드 여부는 `git ls-remote --heads origin codex/free-node-test`의 커밋과 로컬 HEAD를 비교해 확인한다. 소스 업로드와 Render 서버 배포는 별개다.
- 환경 설정 초안의 도메인 추가는 현재 실행 환경에 즉시 적용되지 않는다. Render 네트워크 접근과 계정 연결이 마련되면 실제 배포·외부 접속을 계속 확인해야 한다.

에이전트가 관리 API로 추가 배포나 설정 변경을 하려면 Render 계정에서 API 키를 발급해 클라우드 환경의 보안 설정에 `RENDER_API_KEY`로 연결한다. 키 원문을 채팅에 보내지 않는다. 브라우저에 로그인한 상태만으로 에이전트의 API 인증이 생기지는 않는다. 이미 배포된 공개 앱의 읽기 전용 상태 확인에는 Render 관리 API 키가 필요하지 않으며, 네트워크 접근이 허용되어야 한다.

공식 참고: [Render 무료 인스턴스](https://render.com/docs/free), [Blueprint 명세](https://render.com/docs/blueprint-spec). 현재 클라우드에서 이 공식 페이지의 실시간 내용은 접근 제한으로 확인하지 못했다.
