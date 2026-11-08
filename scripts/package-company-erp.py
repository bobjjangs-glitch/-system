#!/usr/bin/env python3
"""Package seven bridge PHP files and a guide; never existing ERP helpers/private config."""
import hashlib
import pathlib
import sys
import zipfile
root=pathlib.Path(__file__).resolve().parents[1]
out=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else '/workspace/artifacts/bareun-company-erp.zip')
files=['dispatch_api.php','dispatch_setup.php','dispatch_sale.php','inc/dispatch_bridge.php','inc/dispatch_sales.php','inc/dispatch_native.php','inc/dispatch_catalog_native.php']
readme='''바른배차 1.14.0(24) · 오늘 판매내역 자동 조회와 자체 ERP 연결

이 ZIP은 수동 교체용입니다. tire/erp 폴더 구조를 유지하여 FTP의 기존 tire/erp에
다음 PHP 7개를 모두 함께 추가·교체하세요.
 dispatch_api.php
 dispatch_setup.php
 dispatch_sale.php
 inc/dispatch_bridge.php
 inc/dispatch_sales.php
 inc/dispatch_native.php
 inc/dispatch_catalog_native.php
기존 inc/config.php, inc/dispatch_bridge.private.php, native_trade_edit.php 및
원래 ERP 조회 도우미는 교체하지 않습니다. 이 ZIP에 비밀키·DB 설정·사설 원본
ERP 소스는 포함하지 않습니다. 자동 설치 ZIP은 별도 제공됩니다.

1. ERP 관리자로 다음 연결 확인 화면에 로그인합니다.
https://bobjjangs1231.dothome.co.kr/tire/erp/dispatch_setup.php
기존 연동키는 그대로 사용합니다. 처음 설치할 때만 연동키를 발급합니다.
2. Render Environment의 기존 설정을 유지하거나 처음에만 등록합니다.
COMPANY_ERP_API_URL=https://bobjjangs1231.dothome.co.kr/tire/erp/dispatch_api.php
COMPANY_ERP_TOKEN=ERP에서 발급한 연동키
키는 채팅·앱·공개 저장소에 넣지 마세요.
3. 연결 확인 화면에서 현재 조회 저장소가 erp_ecount_documents, 연동 버전이
1.13 이상인지 확인합니다(이 패키지는 1.14.0). ‘이 저장소에 실제로 있는 최근 전표’를 선택하여 기존
ERP 편집기와 대조합니다. 과거 예시 번호가 현재 DB에도 있다고 가정하지 않습니다.
사용 중인 수정 주소가 native_trade_edit.php?id=129470이면 다음으로 대조합니다.
https://bobjjangs1231.dothome.co.kr/tire/erp/dispatch_setup.php?documentId=129470
129470은 문서 ID이며 전표의 마지막 순번과 다릅니다. 다른 건은 실제 id를 씁니다.
4. 필요한 기존 무료 Render 내역을 보관한 뒤 codex/free-node-test에서 해당
릴리스 커밋을 배포하고 1.14.0(24) 앱을 설치합니다. Render 인증·배포는 사용자가
진행합니다. 앱 ‘명세서’에서도 동일한 실제 표시 전표번호를 대조합니다.

이번 연결은 실제 native_trade_edit.php와 같은 회사 DB의 원본 보관 자료를
읽습니다. erp_ecount_* 테이블 이름은 외부 E카운트 API 연동을 뜻하지 않습니다.
현재 current_version_id의 원본 행과 해당 버전에 저장된 마지막 수정본을 읽고,
설치된 ERP 도우미의 회사·거래처·명세서·품목·공장도가·DOT 기본값을 적용합니다.
표시 전표번호와 내부 source_doc 자료 번호가 달라도 구분합니다. 원본 보관 건은
‘ERP 보관 전표’이며 작성중·확정 상태를 추측하지 않습니다. 없는 금액은 미확인으로
유지하고 부가세를 일괄 10%로 만들지 않습니다. 원본 항목과 소수 값도 보존합니다.

기존 business_source_service.php, native_line_view.php, native_sale_partner.php,
statement_print.php, statement_source_service.php, company_service.php 및 이들의
종속 도우미는 원래 ERP의 호환 버전을 그대로 사용합니다. 누락·버전 불일치·원본
DB 오류는 해당 오류로 중단합니다. 빈 일반 판매 DB로 몰래 전환하지 않습니다.
원본 읽기에는 DB 설치/마이그레이션이나 ‘앱 판매 작성 허용 · 저장소 준비’가
필요하지 않습니다. 키·원본 판매·확정·재고를 변경하지 않는 읽기 전용 조회입니다.

전표 화면을 열면 한국 날짜의 오늘 판매내역과 거래처·품목을 자동 조회합니다.
오늘 20건이면 전체 20건을 표시하며 1분마다, 앱 복귀·날짜 변경 시 갱신합니다.
과거 날짜를 직접 선택하면 그 날짜를 유지하고 오늘 버튼으로 돌아옵니다. 자동
목록 조회는 JSON 내역·배송지를 반복 생성하지 않습니다. 전표를 누르면 선택한
원본 ID로 최신 전체 내용과 품목·단가·금액·DC율을 작성 화면에 채웁니다.
20261106-72와 26/11/06-72를 같은 날짜·순번으로 검색합니다. ERP 일자와 번호
날짜가 다르면 원본 일자를 보존해 따로 표시합니다. 구형 PHP·다른 원본 저장소의
결과는 정상 0건으로 표시하지 않습니다. 정상 설치된 PHP 1.13 이상과 호환되며,
이미 정상 연결됐다면 기존 원래 ERP 도우미·연동키를 유지합니다.
양수 수량·확인된 음수 아닌 합계 등 배송 조건을 확인하고 ‘확인하고 전표 등록’으로
앱 배송 전표를 등록합니다. 원본이 바뀌면 재확인하고 중복 등록을 방지합니다.
조회·기존 전표 등록은 ERP 판매/확정/재고를 변경하지 않습니다. 하루 2,000건 초과나
페이지 사이 변경은 부분 성공으로 저장하지 않습니다. 지역별 배차 추천은 구·시·군을
기준으로 묶으며 회사 출발·복귀와 배송지 체류 설정을 반영합니다.

새 수기 판매전표는 별도 일반 ERP 저장소 erp_trades의 작성중 전표입니다.
원본 보관 전표를 새로 작성하거나 수정하는 기능은 아닙니다. 이 별도 작성 기능을
쓸 때만 ‘앱 판매 작성 허용 · 저장소 준비’를 사용합니다(DB CREATE/ALTER 필요).
ERP 판매 확정·재고·수금은 기존 ERP에서 처리합니다. 일반 판매 저장소가 함께 있으면
날짜별 조회에서 두 출처를 구분하며 같은 내부 ID를 서로 다른 전표로 취급합니다.
앱 내역/배송지를 삭제해도 ERP 원본은 삭제되지 않습니다. APP_DATA_DIR은 반드시
영속 저장소로 운영하세요. 무료 Render의 임시 DB가 지워지면 앱 내역도 사라집니다.

요구 사항: PHP 8.1 이상, 기존 ERP 설정과 호환되는 원래 조회 도우미·DB.
검증은 PHP 8.3/MariaDB 10.11에서 제공받은 실제 편집기·도우미 함수와 가상 자료로
수행했습니다. 제공되지 않은 부가 서비스는 테스트용으로만 대체했습니다. 실제
운영 자료 조회·닷홈 설치·Render 배포·실제 휴대폰/GPS 검증을 대신하지 않습니다.
원래 도우미가 바뀌면 호환성을 다시 확인하세요. 릴리스 커밋·공개 ZIP/APK SHA-256은
해당 릴리스에서 확인하고, 원래 도우미 버전·해시는 관리자 환경에서 비교합니다.
현재 자동 조회 안내: 저장소 docs/ERP_1_14_AUTO_SALES.md
원본 PHP 배치·도우미·문서 ID 진단: docs/ERP_1_13_NATIVE.md
'''
out.parent.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(out,'x',compression=zipfile.ZIP_DEFLATED) as z:
 for name in files:
  path=root/'deploy/company-erp/erp'/name
  assert path.is_file() and not path.is_symlink()
  z.write(path,'tire/erp/'+name)
 z.writestr('설치안내.txt',readme)
with zipfile.ZipFile(out) as z:
 assert z.testzip() is None
 assert len(z.namelist())==len(files)+1
 assert not any('private.php' in x or x.endswith('/config.php') for x in z.namelist())
digest=hashlib.sha256(out.read_bytes()).hexdigest()
out.with_suffix(out.suffix+'.sha256').write_text(digest+'  '+out.name+'\n')
print(f'Created {out} ({out.stat().st_size:,} bytes; 7 PHP files and installation guide)')
