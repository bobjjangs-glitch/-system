# 바른배차 Android 1.7.0(17)

Source: `d369e1f` on `codex/free-node-test`.

[Android APK](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.7.0-d369e1f/bareun-dispatch-1.7.0.apk) · [Galaxy A16 ZIP](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.7.0-d369e1f/bareun-a16.zip)

휴대폰 Chrome에서 다운로드 후 기존 앱 위에 설치합니다. ZIP은 압축을 풀어 APK를 설치합니다. PIN 로그인이 필요합니다. Android 7.0 이상, APK에는 ARM64/ARM32가 포함되고 A16 ZIP은 ARM64 전용입니다. iOS 설치 파일은 포함하지 않습니다.

E카운트 품목 목록/코드 직접 조회를 추가했습니다. Render에 ECOUNT_COM_CODE, ECOUNT_USER_ID, ECOUNT_API_CERT_KEY, ECOUNT_ENV를 설정하고 소스 최신 커밋을 배포해야 합니다. 실제 계정 인증/응답 확인은 아직 필요합니다. 현재 메뉴의 거래처 등록/판매 입력은 쓰기 기능이므로 거래처/판매내역 직접 조회는 미지원이며 E카운트에 공식 조회 방법을 확인해야 합니다. 기존 파일 가져오기는 엑셀 파일 가져오기(수동)에서만 열립니다. API 조회 자료에는 조회 시각과 캐시 여부를 표시합니다. 실제 계정 연동 완료나 무제한 실시간 동기화를 의미하지 않습니다. 기존 배송 운행/도착 확인/다음 코스 안내/OCR/터치 배차는 유지합니다. [연결 안내](https://github.com/bobjjangs-glitch/-system/blob/codex/free-node-test/docs/ECOUNT_LIVE_API.md)를 참고하세요. 무료 Render 재배포 전에 필요한 내역을 백업하세요.

Public download is authorized by the repository owner. No customer receipt, PIN or server secret is included.
