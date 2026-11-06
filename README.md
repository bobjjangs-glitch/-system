# 바른배차 Android 1.11.0(21)

Source: `2afd904` on `codex/free-node-test`.

[Android APK](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.11.0-2afd904/bareun-dispatch-1.11.0.apk) · [닷홈 ERP 연결 ZIP](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.11.0-2afd904/bareun-company-erp.zip) · [Galaxy A16 ZIP](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.11.0-2afd904/bareun-a16.zip)

휴대폰 Chrome에서 다운로드 후 기존 앱 위에 설치합니다. ZIP은 압축을 풀어 APK를 설치합니다. PIN 로그인이 필요합니다. Android 7.0 이상, APK에는 ARM64/ARM32가 포함되고 A16 ZIP은 ARM64 전용입니다. iOS 설치 파일은 포함하지 않습니다.

회사 닷홈 ERP의 거래처/품목과 날짜별 확정 판매전표를 버튼/검색 실행 시 직접 조회합니다. 명세서 탭에서 20261106-49 같은 전표번호로 ERP 전체 내용을 직접 조회합니다. 날짜별 판매목록은 ERP 판매일자와 전표번호 날짜를 함께 확인합니다. 2354518과 235/45r18은 동일한 규격을 찾고, 휴대폰 품목은 가로 넘김 없는 세로 카드입니다. 수기 입력의 고객명·차량번호 입력란은 제거했습니다. 공급자·거래처·배송정보·고객명·차량번호·품목·원본 단가·금액·부가세·합계·적요·공장도가·DC율을 표시하며 선택한 전표만 배차 대기에 넣습니다. 취소·반품은 배차하지 않습니다. 새 전표 품목 선택 시 거래처 소매/도매 구분에 맞는 단가와 금액을 자동 채웁니다. 새 전표는 한국 오늘 날짜, ERP 저장 순서의 YYYYMMDD-번호로 ERP 작성중 판매내역과 배송지를 함께 저장하며 재시도 중복을 방지합니다. 기존 ERP 확정·재고 처리는 ERP에서 진행합니다. ZIP의 tire/erp 안 PHP 파일 5개를 기존 ERP에 추가/교체하고 dispatch_setup.php를 ERP 관리자로 열어 ‘앱 판매 작성 허용 · 저장소 준비’를 다시 눌러 새 공장도가 스냅샷 열을 준비하세요. 기존 연결키는 유지하며 처음 설치할 때만 발급합니다. Render Environment의 COMPANY_ERP_API_URL은 dispatch_api.php의 HTTPS 주소, COMPANY_ERP_TOKEN은 발급된 키입니다. 키를 채팅/앱/저장소에 넣지 마세요. 필요한 무료 서버 내역을 백업하고 소스 최신 커밋을 수동 배포해야 합니다. APK 제작 전에 서버 208개와 실제 PHP·MariaDB·모바일 브라우저 16개 검증을 통과했습니다. 회사의 인증된 실제 48/49 자료를 직접 읽은 것은 아닙니다. 실제 닷홈 파일 설치·Render 배포·실기기 확인은 아직 필요합니다. ERP 관리자의 dispatch_setup.php에서 전표 조회 테스트로 운영 원본을 대조할 수 있습니다. 앱 배송지 삭제는 ERP 판매를 삭제하지 않습니다. 진행 중 저장 복구를 위해 서버 APP_DATA_DIR과 ERP DB를 영속 보관하세요. 가져온 전표를 검토하여 저장해야 배송지가 생성되며, 이미 등록한 전표는 중복 저장하지 않습니다. 작성중/취소/0 이하 수량 포함 전표는 제외하고 알립니다. 기존 배송 운행/도착 확인/다음 코스 안내/OCR/터치 배차를 유지합니다. [설치·검증 안내](https://github.com/bobjjangs-glitch/-system/blob/codex/free-node-test/docs/ERP_REFERENCE_LOOKUP.md)를 확인하세요.

Public download is authorized by the repository owner. No customer receipt, PIN or server secret is included.

## FTP에 파일 하나로 적용

[ERP 자동 적용 ZIP 다운로드](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.11.0-2afd904/bareun-erp-install.zip)

1. ZIP을 풀어 `bareun_update_1_11.php` 하나를 기존 FTP의 `tire/erp` 폴더에 올립니다. 기존 `index.php`와 `inc` 폴더가 있는 위치입니다.
2. ERP 관리자 계정으로 로그인하고 https://bobjjangs1231.dothome.co.kr/tire/erp/bareun_update_1_11.php 를 엽니다.
3. **백업하고 ERP 파일 5개 적용**을 누릅니다. 고정된 파일 5개만 검증·백업·교체하며 오류 시 자동 복구합니다. 기존 설정·연동키·DB·판매·재고는 변경하지 않습니다. 성공 후 설치 파일은 자동 삭제됩니다.
4. 자동으로 열리는 ERP 전표 조회 테스트에서 `20261106-49`, 이어서 `20261106-48`의 원본 결과를 확인합니다.
5. Render 배포는 사용자가 직접 진행하기로 했습니다. `codex/free-node-test`의 `2afd904`을 배포하고 APK를 설치합니다. 수기 판매 입력을 아직 허용하지 않은 ERP에서는 `dispatch_setup.php`의 판매 작성 허용·저장소 준비도 진행합니다. 기존 연결키는 재발급하지 않습니다.

자동 설치기는 실제 PHP에서 관리자 권한·CSRF·파일 무결성·설정과 키 보존·성공 후 삭제·재실행·잘못된 경로 거절·실패 시 복구 **6개 검증**을 통과했습니다. 운영 FTP 적용과 회사 원본 전표 확인은 아직 실행하지 않았습니다. 연결된 사용자 PC의 FTP 창을 클라우드에서 조작할 수 없어 위의 한 파일 업로드는 사용자가 진행해야 합니다.
