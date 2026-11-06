# 바른배차 Android 1.8.0(18)

Source: `b8bf24c` on `codex/free-node-test`.

[Android APK](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.8.0-b8bf24c/bareun-dispatch-1.8.0.apk) · [닷홈 ERP 연결 ZIP](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.8.0-b8bf24c/bareun-company-erp.zip) · [Galaxy A16 ZIP](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.8.0-b8bf24c/bareun-a16.zip)

휴대폰 Chrome에서 다운로드 후 기존 앱 위에 설치합니다. ZIP은 압축을 풀어 APK를 설치합니다. PIN 로그인이 필요합니다. Android 7.0 이상, APK에는 ARM64/ARM32가 포함되고 A16 ZIP은 ARM64 전용입니다. iOS 설치 파일은 포함하지 않습니다.

회사 닷홈 ERP의 거래처/품목과 날짜별 확정 판매전표를 버튼/검색 실행 시 직접 조회합니다. ZIP의 tire/erp 안 PHP 파일 3개를 기존 ERP에 추가하고 dispatch_setup.php를 ERP 관리자 계정으로 열어 키를 발급하세요. Render Environment의 COMPANY_ERP_API_URL은 dispatch_api.php의 HTTPS 주소, COMPANY_ERP_TOKEN은 발급된 키입니다. 키를 채팅/앱/저장소에 넣지 마세요. 필요한 무료 서버 내역을 백업하고 소스 최신 커밋을 수동 배포해야 합니다. 실제 닷홈 FTP 설치/키 설정은 아직 필요합니다. 가져온 전표를 검토하여 저장해야 배송지가 생성되며, 이미 등록한 전표는 중복 저장하지 않습니다. 작성중/취소/0 이하 수량 포함 전표는 제외하고 알립니다. 기존 배송 운행/도착 확인/다음 코스 안내/OCR/터치 배차를 유지합니다. [설치·검증 안내](https://github.com/bobjjangs-glitch/-system/blob/codex/free-node-test/docs/COMPANY_ERP_LIVE.md)를 확인하세요.

Public download is authorized by the repository owner. No customer receipt, PIN or server secret is included.
