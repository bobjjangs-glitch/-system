# LDPlayer 테스트 APK

현재 우선 대상은 LDPlayer 9의 64비트 Android 환경이다. `x86_64` APK를 release 모드로 빌드해 JavaScript 번들을 포함한다. Metro나 Expo Go가 없어도 실행되며 API는 `https://bareun-dispatch-test.onrender.com`을 사용한다. 휴대폰 직원 배포용 서명과 기기 호환 검증은 별도다.

## 로컬 Android 빌드

이 클라우드에는 Node.js 24, JDK 17/21, Android SDK 36과 Gradle이 준비되어 있다. 네이티브 프로젝트는 이미 생성했으며 앱의 native 의존성·설정 변경이 없으므로 clean prebuild를 반복하지 않는다.

```bash
cd /workspace/-system
bash scripts/build-ldplayer-apk.sh
```

이 명령은 기존 생성 프로젝트의 테스트 서명 키를 사용한다. APK가 실제 생성되고 apksigner 검증이 성공한 뒤에만 `/workspace/artifacts/`에 `.apk`와 체크섬을 복사한다. 실패한 빌드의 번들·ZIP 파일을 설치용 APK라고 제공하지 않는다. 직원용 정식 배포는 `eas.json`의 `internal` 프로필과 소유자가 관리하는 서명 키를 사용한다.

빌드 스크립트는 `deploy/android/ldplayer-resource-limits.gradle`을 적용해 Metro 작업자 2개, C++ 컴파일 2개·링크 1개로 제한한다. Gradle 작업자는 기본 2개이며 `BAREUN_GRADLE_WORKERS=1`부터 `4`까지 선택할 수 있다. 클라우드가 표시하는 호스트 CPU 수만큼 작업을 늘리지 않는다.

## Expo 클라우드 빌드

별도로 Expo 인증과 프로젝트 연결이 완료된 환경에서는 다음 프로필을 사용할 수 있다.

```bash
eas build --platform android --profile ldplayer
```

`ldplayer` 프로필은 현재 Render 테스트 주소와 x86_64 빌드 타깃을 명시한다. 카페24 운영 서버로 바꿀 때는 실제 서버 주소를 EAS 빌드 프로필의 공개 환경 변수에도 반영해야 한다.

## 완료된 빌드와 검증

실행 환경의 네트워크 허용이 반영된 뒤 공식 React Native release AAR 다운로드가 성공했고, 다음 명령으로 APK를 생성했다. 프록시·TLS·체크섬 검증을 유지했다.

```bash
EXPO_PUBLIC_API_URL=https://bareun-dispatch-test.onrender.com BAREUN_GRADLE_WORKERS=2 bash scripts/build-ldplayer-apk.sh
```

생성 파일은 `/workspace/artifacts/bareun-dispatch-ldplayer-x86_64-test-0ee74c4.apk`이며 크기는 31,365,731바이트다. 같은 경로의 `.apk.sha256` 파일에 SHA-256 체크섬이 있다. Gradle `assembleRelease`와 APK v2 서명 검증이 통과했다. 추가로 ZIP 무결성, 16KB 정렬, x86_64 네이티브 라이브러리, 내장 JavaScript 번들과 Render 주소, 체크섬을 확인했다. 앱 ID는 `com.bobjjang.bareundispatch`, 버전은 1.0.0(1), 최소 Android API는 24다.

Expo CLI의 `eas whoami`는 `Not logged in`을 반환했다. 로컬 Android 빌드에는 Expo 로그인이 필요 없지만 Expo 클라우드 빌드를 사용하려면 별도 인증이 필요하다. iPhone IPA는 우선순위가 뒤이며 Apple Developer 계정과 기기 등록·서명이 필요하다.

## 설치 확인

LDPlayer 9의 64비트 Android 인스턴스에 APK 파일을 끌어다 놓거나 APK 설치 메뉴로 선택한다. Expo Go나 Metro를 실행할 필요가 없다. 실제 LDPlayer 설치·실행은 아직 확인하지 않았다. 설치 후 앱 실행·관리자 PIN 로그인·기사 PIN 보기·전표·코스 화면을 확인한다. 위치 테스트에는 LDPlayer의 가상 위치를 사용하며 실제 배송 기기의 GPS·백그라운드 동작 검증으로 간주하지 않는다. 이 파일은 x86_64 테스트용이며 ARM 휴대폰용 배포 파일은 별도로 빌드한다.
