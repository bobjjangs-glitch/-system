# 바른배차 Android 1.9.0(19)

Source: `9656921` on `codex/free-node-test`.

[Android APK](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.9.0-9656921/bareun-dispatch-1.9.0.apk) · [닷홈 ERP 연결 ZIP](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.9.0-9656921/bareun-company-erp.zip) · [Galaxy A16 ZIP](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.9.0-9656921/bareun-a16.zip)

휴대폰 Chrome에서 다운로드 후 기존 앱 위에 설치합니다. ZIP은 압축을 풀어 APK를 설치합니다. PIN 로그인이 필요합니다. Android 7.0 이상, APK에는 ARM64/ARM32가 포함되고 A16 ZIP은 ARM64 전용입니다. iOS 설치 파일은 포함하지 않습니다.

회사 닷홈 ERP의 거래처/품목과 날짜별 확정 판매전표를 버튼/검색 실행 시 직접 조회합니다. 입력 표의 품목코드·품목명·패턴·수량·단가·금액·합계·비고·DC율을 지원합니다. 새 전표는 한국 오늘 날짜, ERP 저장 순서의 YYYYMMDD-번호로 ERP 작성중 판매내역과 배송지를 함께 저장하며 재시도 중복을 방지합니다. 기존 ERP 확정·재고 처리는 ERP에서 진행합니다. ZIP의 tire/erp 안 PHP 파일 5개를 기존 ERP에 추가/교체하고 dispatch_setup.php를 ERP 관리자로 열어 ‘앱 판매 작성 허용 · 저장소 준비’를 누르세요. 기존 연결키는 유지하며 처음 설치할 때만 발급합니다. Render Environment의 COMPANY_ERP_API_URL은 dispatch_api.php의 HTTPS 주소, COMPANY_ERP_TOKEN은 발급된 키입니다. 키를 채팅/앱/저장소에 넣지 마세요. 필요한 무료 서버 내역을 백업하고 소스 최신 커밋을 수동 배포해야 합니다. 실제 닷홈 FTP 설치·판매 작성 설정·Render 배포는 아직 필요합니다. 앱 배송지 삭제는 ERP 판매를 삭제하지 않습니다. 진행 중 저장 복구를 위해 서버 APP_DATA_DIR과 ERP DB를 영속 보관하세요. 가져온 전표를 검토하여 저장해야 배송지가 생성되며, 이미 등록한 전표는 중복 저장하지 않습니다. 작성중/취소/0 이하 수량 포함 전표는 제외하고 알립니다. 기존 배송 운행/도착 확인/다음 코스 안내/OCR/터치 배차를 유지합니다. [설치·검증 안내](https://github.com/bobjjangs-glitch/-system/blob/codex/free-node-test/docs/COMPANY_ERP_LIVE.md)를 확인하세요.

Public download is authorized by the repository owner. No customer receipt, PIN or server secret is included.
