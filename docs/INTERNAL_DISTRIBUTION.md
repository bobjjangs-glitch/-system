# 직원용 설치 안내

앱을 App Store·Google Play에 공개하지 않고 직원에게만 설치 파일·설치 링크를 전달합니다. 계정 로그인과 서명은 소유자 계정으로 진행하며, 비밀번호·인증서·키를 채팅이나 Git에 올리지 않습니다.

## 먼저 준비할 것

1. 직원 휴대폰에서 접근 가능한 HTTPS 서버와 영구 데이터 디스크를 준비합니다. 사외 배송 중에도 서버에 접속할 수 있어야 합니다. 회사망만 사용할 경우 직원 휴대폰에 회사 VPN 접근도 준비합니다.
2. 서버의 `NODE_ENV=production`, `APP_DATA_DIR`, `DISPATCH_BOOTSTRAP_TOKEN`, 필요 시 `CORS_ORIGINS`를 보안 설정에서 공급합니다. 서버를 시작하고 첫 관리자를 등록합니다.
3. Expo 계정을 만들거나 기존 계정으로 EAS CLI에 로그인하고 프로젝트를 연결합니다. 클라우드 개발 도구는 `/workspace/.expo-development/tools/node_modules/.bin/eas`에 설치됩니다.
4. 앱 빌드 환경의 `EXPO_PUBLIC_API_URL`에 실제 HTTPS 서버 주소를 넣습니다. EAS 클라우드 빌드는 해당 빌드 프로필의 `env` 또는 EAS 환경 변수에도 이 값을 설정합니다. 개발 PC의 환경 변수만으로 원격 빌드에 전달됐다고 가정하지 않습니다. 이 주소는 비밀 키가 아니며 앱에 포함됩니다. 변경하면 앱을 다시 빌드해야 합니다.
5. 앱 식별자 `com.bobjjang.bareundispatch`를 회사 계정에서 소유할 식별자로 확인합니다. 서명 키를 유지해야 이후 업데이트를 같은 앱 위에 설치할 수 있습니다.

## Android

LDPlayer에서 먼저 설치·테스트할 경우 `docs/LDPLAYER_APK.md`의 x86_64 APK 절차를 사용합니다. `ldplayer` 프로필은 현재 Render 테스트 서버를 사용하며 직원 배포용 `internal` 프로필과 구분합니다.

실제 Android 휴대폰의 내부 테스트에는 [ANDROID_PHONE_APK.md](ANDROID_PHONE_APK.md)를 따릅니다. `bash scripts/build-android-phone-apk.sh`로 ARM 64비트·32비트를 포함한 설치 파일을 로컬에서 만들 수 있으며 이 경로에는 Expo 로그인이 필요 없습니다. 기존 테스트 인증서와 현재 Render 테스트 서버를 사용합니다.

```bash
eas build --platform android --profile internal
```

`internal` 프로필은 AAB 대신 APK를 생성합니다. EAS의 Android 서명 키 관리 절차를 완료한 뒤 빌드 결과의 설치 링크 또는 APK를 직원에게만 전달합니다. 직원은 해당 다운로드 출처의 앱 설치를 허용한 후 설치합니다. Google Play 등록은 필요 없습니다.

회사 운영용 서명 키는 Expo 계정 등 소유자가 관리하는 보안 저장소에 백업하고 업데이트마다 같은 키를 사용합니다. 현재 Expo 계정 로그인은 수행하지 않았으며, 로컬에서는 기존 테스트 인증서를 사용한 설치용 APK를 생성합니다. 설치 파일 전달과 실제 휴대폰 GPS 검증은 별개입니다.

## iPhone — Apple Developer 계정이 아직 없는 경우

1. Apple Developer Program에 가입합니다. 일반 직원 5명 정도라면 기기 등록 방식인 Ad Hoc 배포를 사용할 수 있습니다. App Store 심사를 거치지 않아도 Apple의 개발자 가입과 앱 서명은 필요합니다.
2. 가입 승인 후 회사의 Apple Team을 EAS 빌드에 연결합니다. 회사 소유 계정과 접근 권한을 사용합니다.
3. `eas device:create`로 직원 iPhone을 등록하고 UDID를 수집합니다. 직원이 개인 인증 정보 대신 기기 등록 절차를 진행합니다.
4. 등록된 기기를 포함한 Ad Hoc 프로비저닝 프로파일로 빌드합니다.

```bash
eas build --platform ios --profile internal
```

5. 빌드 결과의 내부 설치 링크를 등록된 직원에게 전달합니다. 등록되지 않은 iPhone에는 설치되지 않습니다. 새 기기를 추가하면 프로파일 갱신과 재빌드 또는 재서명이 필요합니다.

Apple의 기기 등록 한도·인증서·프로비저닝 프로파일의 유효기간을 관리해야 합니다. 일반 IPA 파일을 임의의 링크로 제공하는 것만으로 모든 iPhone에 설치할 수는 없습니다. 현재 Apple Developer 계정이 없어 iPhone용 서명·설치는 진행하지 않았습니다.

직원 수가 크게 늘어날 경우 Apple Business Manager의 비공개 Custom App 배포도 검토할 수 있습니다. 이는 별도 등록·심사 절차가 있는 방식입니다.

## 설치 후 실제 기기 확인

- 관리자: 회사 출발·복귀 주소와 배송지 좌표 확인, 기사별 PIN 발급.
- 기사: 자신의 PIN 로그인, 첫 코스와 물품 확인, 위치 권한 허용.
- 앱을 열어 둔 상태의 위치 공유 확인.
- 백그라운드 위치 권한을 허용한 자체 설치 앱에서 길안내 앱으로 전환한 뒤 관리자 화면의 위치 갱신 확인.
- 배송 완료와 미배송 사유 처리, 마지막 배송 후 회사 길안내 확인.
- 회사 복귀 완료 또는 로그아웃 후 위치 공유 중단 확인.
- Android·iPhone 각각 카메라, 사진, 엑셀 업로드·원본 다운로드 확인.

실제 기기 GPS 동작과 서명된 설치 파일 검증은 이 클라우드의 JavaScript 번들·API 테스트와 구분합니다.
