<?php
/** Read-only adapter for the company's installed native archive/editor. Never imports or posts a sale. */
declare(strict_types=1);

final class DispatchNativeReadError extends RuntimeException {
    public string $nativeCode;
    public function __construct(string $code, string $message) { parent::__construct($message); $this->nativeCode=$code; }
}
function bd_native_problem(string $code,string $message): void { throw new DispatchNativeReadError($code,$message); }
function bd_native_table_engine(PDO $pdo,string $table): ?string {
    if(!in_array($table,['erp_ecount_documents','erp_ecount_doc_lines','erp_ecount_trade_edits','erp_ecount_sale_types'],true))throw new InvalidArgumentException('원본 조회 항목을 확인해 주세요.');
    $q=$pdo->prepare('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?');
    $q->execute([$table]);$value=$q->fetchColumn();return $value===false?null:strtoupper((string)$value);
}
/** Absent native storage permits legacy routing; an incomplete native store never silently falls back. */
function bd_native_ready(PDO $pdo): bool {
    $documents=bd_native_table_engine($pdo,'erp_ecount_documents');$lines=bd_native_table_engine($pdo,'erp_ecount_doc_lines');
    if($documents===null&&$lines===null)return false;
    if($documents!=='INNODB'||$lines!=='INNODB')bd_native_problem('NATIVE_SCHEMA','원본 이관 전표 DB가 완전히 준비되지 않았습니다. 기존 ERP 원본 조회 설정을 확인해 주세요.');
    return true;
}
function bd_native_load_helpers(): void {
    $groups=[
        'business_source_service.php'=>['bs_ready'],
        'native_line_view.php'=>['nlv_catalog','nlv_pick','nlv_number','nlv_display','nlv_trade_type','nlv_amounts'],
        'statement_print.php'=>['statement_factory_prices','statement_line_factory'],
        'statement_source_service.php'=>['statement_source_load'],
        'native_sale_partner.php'=>['native_sale_find_partner','native_sale_partner_fields','statement_options','statement_source_balances'],
        'company_service.php'=>['cp_load'],
    ];
    foreach($groups as $file=>$functions){
        if(count(array_filter($functions,'function_exists'))===count($functions))continue;
        if(!is_file(__DIR__.'/'.$file))bd_native_problem('NATIVE_HELPER_MISSING','회사 ERP의 원본 조회 도우미 '.$file.'를 확인해 주세요.');
        try { @require_once __DIR__.'/'.$file; }
        catch(Throwable $error){bd_native_problem('NATIVE_HELPER_LOAD','회사 ERP의 원본 조회 도우미 '.$file.'와 연결된 파일을 불러오지 못했습니다.');}
        foreach($functions as $function)if(!function_exists($function))bd_native_problem('NATIVE_HELPER_VERSION','회사 ERP의 원본 조회 도우미 '.$file.' 버전을 확인해 주세요.');
    }
    foreach(['cfg','item_dot_reference_rows','item_dot_short'] as $function)
        if(!function_exists($function))bd_native_problem('NATIVE_HELPER_VERSION','회사 ERP 원본 조회에 필요한 '. $function .' 도우미를 확인해 주세요.');
}
function bd_native_text($value,string $field='항목'): string {
    if($value===null)return '';
    if(!is_scalar($value))bd_native_problem('NATIVE_DATA','원본 전표의 '.$field.' 형식을 확인해 주세요.');
    return (string)$value;
}
function bd_native_raw(string $json,string $field): array {
    try{$value=json_decode($json,true,32,JSON_THROW_ON_ERROR);}catch(JsonException $error){bd_native_problem('NATIVE_DATA','원본 전표의 '.$field.' JSON을 확인해 주세요.');}
    if(!is_array($value))bd_native_problem('NATIVE_DATA','원본 전표의 '.$field.' 형식을 확인해 주세요.');
    return $value;
}
function bd_native_date(string $value): bool {
    $date=DateTimeImmutable::createFromFormat('!Y-m-d',$value);return $date!==false&&$date->format('Y-m-d')===$value;
}
/** Match number spellings, while returning the original editor display string separately. */
function bd_native_reference_parts(string $reference): ?array {
    $value=preg_replace('/\s+/u','',mb_convert_kana($reference,'as','UTF-8'));
    $value=preg_replace('/^SL-/i','',$value??'');
    if(!preg_match('/^(.+)-(\d{1,12})$/D',$value,$parts))return null;
    $datePart=$parts[1];
    if(preg_match('/^(\d{4})(\d{2})(\d{2})$/D',$datePart,$m))$date=$m[1].'-'.$m[2].'-'.$m[3];
    elseif(preg_match('/^(\d{2}|\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})$/D',$datePart,$m))$date=(strlen($m[1])===2?'20':'').$m[1].'-'.str_pad($m[2],2,'0',STR_PAD_LEFT).'-'.str_pad($m[3],2,'0',STR_PAD_LEFT);
    else return null;
    if(!bd_native_date($date))return null;$sequence=ltrim($parts[2],'0');if($sequence==='')$sequence='0';
    return ['date'=>$date,'sequence'=>$sequence,'canonical'=>$date.'-'.$sequence];
}
function bd_native_identity(array $doc,array $original): string {
    if(!$original)return bd_native_text($doc['source_doc']??'','전표번호');
    $headers=[];foreach($original as $row){if(!is_array($row))bd_native_problem('NATIVE_DATA','원본 전표의 품목 행 형식을 확인해 주세요.');foreach($row as $header=>$_)if(!array_key_exists($header,$headers))$headers[$header]=true;}
    $number=bd_native_text($doc['source_doc']??'','전표번호');$first=array_key_first($headers);
    foreach($headers as $header=>$_){
        $key=preg_replace('/\s+/u','',(string)$header);
        if(!in_array($key,['판매번호','구매번호','전표번호','일자-No.','일자-No'],true)&&$header!==$first)continue;
        $value=bd_native_text($original[0][$header]??'','표시 전표번호');
        if($value!==''&&preg_match('~^[0-9/]+\s*-\s*[0-9]+$~D',$value)){$number=$value;break;}
    }
    return $number;
}
function bd_native_numeric($value,string $field): ?float {
    $raw=bd_native_text($value,$field);if(trim($raw)==='')return null;
    $number=nlv_number($raw);
    if($number===null||!is_finite($number))bd_native_problem('NATIVE_NUMBER','원본 전표의 '.$field.' 숫자를 확인해 주세요.');
    return $number;
}
function bd_native_string_fields(array $row): array {
    $out=[];foreach($row as $key=>$value)$out[(string)$key]=bd_native_text($value,(string)$key);return $out;
}
function bd_native_money_sum(array $items,string $field): ?float {
    $total=0.0;foreach($items as $item){if(!array_key_exists($field,$item)||$item[$field]===null)return null;$total+=$item[$field];if(!is_finite($total))bd_native_problem('NATIVE_NUMBER','원본 전표의 합계 범위를 확인해 주세요.');}return $total;
}
/** Exactly the installed sale editor's GET pipeline; caller owns the READ ONLY transaction. */
function bd_native_materialize(PDO $pdo,array $doc): array {
    bd_native_load_helpers();
    if(($doc['kind']??'')!=='sale')bd_native_problem('NATIVE_KIND','선택한 원본은 판매전표가 아닙니다.');
    $id=bd_native_text($doc['id']??'','원본 ID');$version=(int)($doc['current_version_id']??0);
    if(!preg_match('/^[1-9][0-9]{0,14}$/D',$id)||$version<1)bd_native_problem('NATIVE_VERSION','원본 전표의 현재 버전을 확인해 주세요.');
    $source=$pdo->prepare('SELECT * FROM `erp_ecount_doc_lines` WHERE version_id=? ORDER BY line_no');$source->execute([$version]);$canonicalRows=$source->fetchAll(PDO::FETCH_ASSOC);
    if(!$canonicalRows)bd_native_problem('NATIVE_LINES','원본 전표에 보관된 품목 행이 없습니다.');
    if(count($canonicalRows)>1000)throw new LengthException('원본 전표의 품목이 1,000행을 넘습니다. 앱에서 부분 전표로 가져오지 않았습니다.');
    $original=[];
    foreach($canonicalRows as $sourceRow){
        foreach(['row_json','line_no','item_code','item_name','spec','brand','qty','unit_price','amount','dc_raw','memo','dot_raw'] as $field)
            if(!array_key_exists($field,$sourceRow))bd_native_problem('NATIVE_SCHEMA','원본 품목의 '.$field.' 열을 확인해 주세요.');
        $original[]=bd_native_raw((string)$sourceRow['row_json'],'품목 원본');
    }
    $saved=null;
    if(bd_native_table_engine($pdo,'erp_ecount_trade_edits')==='INNODB'){
        $latest=$pdo->prepare('SELECT id,rows_json,created_by,created_at FROM `erp_ecount_trade_edits` WHERE document_id=? AND version_id=? ORDER BY id DESC LIMIT 1');$latest->execute([$id,$version]);$saved=$latest->fetch(PDO::FETCH_ASSOC)?:null;
    }
    $snapshot=$saved?bd_native_raw((string)$saved['rows_json'],'수정본'):null;
    if($snapshot!==null&&(!is_array($snapshot['header']??[])||!is_array($snapshot['lines']??$original)))bd_native_problem('NATIVE_DATA','원본 전표 수정본의 항목 형식을 확인해 주세요.');
    $headerFields=['partner_code'=>'거래처코드','partner_name'=>'판매처 · 고객','staff'=>'담당자','warehouse'=>'출하창고','trade_type'=>'거래유형','currency'=>'통화','ceo'=>'대표자','phone'=>'전화','business_no'=>'사업자번호','account'=>'입금계좌번호','receivable'=>'전잔·후잔','delivery'=>'배송지','note'=>'기재 사항'];
    $aliases=['partner_code'=>['거래처코드','판매처코드','구매처코드'],'partner_name'=>['거래처명','거래처','판매처명','구매처명'],'warehouse'=>['출하창고','출고창고','입고창고'],'trade_type'=>['거래유형','유형','부가세구분'],'account'=>['입금계좌번호','입금계좌'],'delivery'=>['배송지','배송주소'],'note'=>['기재사항'],'receivable'=>['미수금','미지급금','잔액']];
    $firstRow=[];foreach($original[0] as $name=>$value)$firstRow[preg_replace('/[\s▶◀]/u','',(string)$name)]=$value;
    $head=[];foreach($headerFields as $field=>$caption){$head[$field]='';foreach($aliases[$field]??[$caption] as $alias)if(($firstRow[$alias]??'')!==''){$head[$field]=bd_native_text($firstRow[$alias],$field);break;}}
    $statementSource=statement_source_load($pdo,$version);
    if(!is_array($statementSource))bd_native_problem('NATIVE_HELPER_DATA','명세서 원본 도우미 응답을 확인해 주세요.');
    foreach(['receivable'=>'balance','account'=>'account','delivery'=>'delivery','note'=>'memo'] as $field=>$sourceField)if($head[$field]===''&&!empty($statementSource[$sourceField]))$head[$field]=bd_native_text($statementSource[$sourceField],$field);
    $sourceTradeType=$head['trade_type'];
    if($sourceTradeType===''&&bd_native_table_engine($pdo,'erp_ecount_sale_types')!==null){$query=$pdo->prepare('SELECT trade_type FROM `erp_ecount_sale_types` WHERE source_doc=?');$query->execute([$doc['source_doc']]);$sourceTradeType=(string)$query->fetchColumn();}
    if(empty($snapshot['header_saved'])){
        $settings=statement_options($pdo,'ecount',$version);
        if(!is_array($settings))bd_native_problem('NATIVE_HELPER_DATA','명세서 설정 도우미 응답을 확인해 주세요.');
        $balances=array_filter($settings,static fn($value)=>$value!==null)+statement_source_balances(array_map(static fn($raw)=>['raw'=>$raw],$original));
        foreach(['account'=>'account','delivery'=>'delivery','note'=>'memo'] as $field=>$option)if($head[$field]===''&&!empty($settings[$option]))$head[$field]=bd_native_text($settings[$option],$field);
        $formatted=[];foreach(['previous_balance'=>'전잔','following_balance'=>'후잔'] as $field=>$caption)if(isset($balances[$field]))$formatted[]=$caption.' '.number_format((int)$balances[$field]).'원';
        if($head['receivable']==='')$head['receivable']=implode(' / ',$formatted);
        $partner=native_sale_find_partner($pdo,$head['partner_code'],$head['partner_name']);$defaults=$partner?native_sale_partner_fields($pdo,$partner):[];
        $company=cp_load($pdo,(array)cfg('company',[]));$defaults['account']??=(string)$company['statement_account'];
        foreach($defaults as $field=>$value){if(!array_key_exists($field,$head))bd_native_problem('NATIVE_HELPER_DATA','거래처 원본 기본 항목을 확인해 주세요.');if($head[$field]==='')$head[$field]=bd_native_text($value,$field);}
    }
    $savedHead=bd_native_string_fields($snapshot['header']??[]);
    if(array_diff_key($savedHead,$headerFields))bd_native_problem('NATIVE_DATA','현재 ERP 편집기의 추가 기본 항목을 확인해 주세요.');
    $head=array_replace($head,!empty($snapshot['header_saved'])?$savedHead:array_filter($savedHead,static fn($value)=>$value!==''));
    if(!empty($statementSource['balance'])&&($head['receivable']===''||str_starts_with($head['receivable'],'현재 잔액 ')))$head['receivable']=bd_native_text($statementSource['balance'],'receivable');
    if($head['trade_type']==='')$head['trade_type']=$sourceTradeType;
    $company=cp_load($pdo,(array)cfg('company',[]));
    if($head['account']==='')$head['account']=(string)$company['statement_account'];
    $rows=$snapshot['lines']??$original;
    if(!array_is_list($rows)||count($rows)!==count($original))bd_native_problem('NATIVE_LINES','수정본과 현재 원본의 품목 행 수가 다릅니다. ERP에서 최신 전표를 확인해 주세요.');
    $headers=[];foreach($original as $row)foreach($row as $key=>$_)if(!in_array($key,$headers,true))$headers[]=$key;
    $itemFields=[];foreach(['code'=>['품목코드','품목코드코드'],'name'=>['품목명','품명및규격','품목명및규격'],'spec'=>['규격'],'pattern'=>['패턴','패턴명'],'brand'=>['브랜드']] as $key=>$names){foreach($headers as $column)if(in_array(preg_replace('/\s+/u','',(string)$column),$names,true)){$itemFields[$key]=$column;break;}if(!isset($itemFields[$key])){$itemFields[$key]=$names[0];$headers[]=$names[0];}}
    foreach($rows as &$row){if(!is_array($row))bd_native_problem('NATIVE_DATA','수정 품목 행의 형식을 확인해 주세요.');$row+=array_fill_keys(array_values($itemFields),'');}unset($row);
    $catalogRows=nlv_catalog($pdo,$canonicalRows);
    if(!is_array($catalogRows)||count($catalogRows)!==count($rows))bd_native_problem('NATIVE_HELPER_DATA','ERP 품목 원본 도우미의 행 수를 확인해 주세요.');
    $factoryPrices=statement_factory_prices($pdo,array_column($catalogRows,'item_code'));$catalogRows=item_dot_reference_rows($pdo,$catalogRows);
    if(!is_array($catalogRows)||count($catalogRows)!==count($rows)||!is_array($factoryPrices))bd_native_problem('NATIVE_HELPER_DATA','ERP 품목 참고 도우미 응답을 확인해 주세요.');
    $items=[];
    foreach($rows as $index=>&$row){
        $canonical=$catalogRows[$index];$type=nlv_trade_type($pdo,$doc,$original[$index]);
        $money=nlv_amounts($row,$canonical['qty'],$canonical['unit_price'],$canonical['amount'],$type,$canonical['_source_money']??[]);
        foreach(['unit','supply','vat','total','rate'] as $field)if(!array_key_exists($field,$money))bd_native_problem('NATIVE_HELPER_DATA','ERP 금액 도우미의 '.$field.' 항목을 확인해 주세요.');
        $factory=statement_line_factory($row)??($statementSource['factories'][(int)$canonical['line_no']]??$factoryPrices[$canonical['item_code']]??null);
        $defaults=['품목코드'=>$canonical['item_code'],'브랜드'=>$canonical['brand'],'품명 및 규격'=>$canonical['item_name'],'패턴'=>nlv_pick($row,['패턴','패턴명'])?:($canonical['_catalog']['pattern_name']??''),'규격'=>$canonical['spec'],'수량'=>$canonical['qty'],'공급가액단가'=>$money['unit'],'공급가액'=>$money['supply'],'부가세'=>$money['vat'],'VAT포함합계'=>$money['total'],'공장도가'=>$factory,'DC율'=>$canonical['dc_raw'],'비고'=>$canonical['memo']];
        foreach($defaults as $key=>$value)if(!array_key_exists($key,$row)||trim(bd_native_text($row[$key],$key))==='')$row[$key]=$value===null?'':(string)$value;
        $quantity=bd_native_numeric($row['수량'],'수량');$discountRaw=bd_native_text($row['DC율'],'DC율');$discount=nlv_number($discountRaw);
        $dot=nlv_pick($row,['DOT','DOT코드'])?:((string)($canonicalRows[$index]['dot_raw']??'')?:'전표 미기재');
        $dotInfo=$canonical['_dot_info']??null;$dotReference=$dotInfo&&($dotInfo['display']??'미확인')!=='미확인'?item_dot_short($dotInfo['display']):'미확인';
        $item=['id'=>(string)$canonical['line_no'],'lineNo'=>(int)$canonical['line_no'],'name'=>bd_native_text($row['품명 및 규격'],'품목명'),'code'=>bd_native_text($row['품목코드'],'품목코드'),'specification'=>bd_native_text($row['규격'],'규격'),'pattern'=>bd_native_text($row['패턴'],'패턴'),'brand'=>bd_native_text($row['브랜드'],'브랜드'),'quantity'=>$quantity??0,'quantityUnknown'=>$quantity===null,'unitPrice'=>bd_native_numeric($row['공급가액단가'],'단가'),'supplyAmount'=>bd_native_numeric($row['공급가액'],'금액'),'vatAmount'=>bd_native_numeric($row['부가세'],'부가세'),'totalAmount'=>bd_native_numeric($row['VAT포함합계'],'합계'),'factoryPrice'=>bd_native_numeric($row['공장도가'],'공장도가'),'discountRate'=>$discount!==null&&$discount>=0&&$discount<=100?$discount:null,'discountRateRaw'=>$discountRaw,'remarks'=>bd_native_text($row['비고'],'비고'),'dot'=>bd_native_text($dot,'DOT'),'dotReference'=>bd_native_text($dotReference,'품목 DOT 참고'),'vatRate'=>$money['rate'],'priceOrigin'=>'native-erp','nativeFields'=>bd_native_string_fields($row)];
        $normalizedType=trim($type);
        if($normalizedType==='면세')$item['taxType']='exempt';elseif(in_array($normalizedType,['부가세율 적용','영세율'],true))$item['taxType']='taxable';
        $catalog=$canonical['_catalog']??null;
        if(is_array($catalog)&&$item['code']===(string)($catalog['item_code']??'')&&preg_match('/^[1-9][0-9]{0,14}$/D',(string)($catalog['id']??'')))$item['erpItemId']=(string)$catalog['id'];
        $item['listPrice']=$item['factoryPrice'];$items[]=$item;
    }unset($row);
    $reference=bd_native_identity($doc,$original);$date=bd_native_text($doc['doc_date']??'','판매일자');
    if(!bd_native_date($date))bd_native_problem('NATIVE_DATE','원본 전표의 판매일자를 확인해 주세요.');
    return ['id'=>$id,'reference'=>$reference,'sourceReference'=>bd_native_text($doc['source_doc'],'원본 전표번호'),'saleDate'=>$date,'status'=>'imported','sourceSystem'=>'native-archive','nativeVersionId'=>(string)$version,'nativeRevision'=>(string)($saved['id']??0),'nativeHeader'=>bd_native_string_fields($head),'editUrl'=>'native_trade_edit.php?id='.$id,'statementUrl'=>'native_document.php?id='.$id.'&version='.$version.'&print=statement','recipient'=>$head['partner_name'],'address'=>$head['delivery'],'phone'=>$head['phone'],'customerCode'=>$head['partner_code'],'customerName'=>'','vehicleNo'=>'','channel'=>'','paymentMethod'=>'','cancelReason'=>'','notes'=>$head['note'],'supplier'=>['name'=>(string)$company['name'],'businessNumber'=>(string)$company['biz_no'],'representative'=>(string)$company['ceo'],'address'=>(string)$company['address'],'phone'=>(string)$company['tel']],'buyer'=>['name'=>$head['partner_name'],'businessNumber'=>$head['business_no'],'representative'=>$head['ceo'],'address'=>'','phone'=>$head['phone']],'supplyAmount'=>bd_native_money_sum($items,'supplyAmount'),'vatAmount'=>bd_native_money_sum($items,'vatAmount'),'amount'=>bd_native_money_sum($items,'totalAmount'),'items'=>$items];
}
function bd_native_date_pattern(string $date,bool $anchored=true): string {
    $d=new DateTimeImmutable($date);$month=(int)$d->format('n');$day=(int)$d->format('j');$m=$month<10?'0?'.$month:(string)$month;$dayPart=$day<10?'0?'.$day:(string)$day;
    $part='(SL-)?('.$d->format('Ymd').'|('.$d->format('Y').'|'.$d->format('y').')[/.-]'.$m.'[/.-]'.$dayPart.')[[:space:]]*-[[:space:]]*[0-9]+';
    return $anchored?'^'.$part.'$':'(^|[^0-9])'.$part.'([^0-9]|$)';
}
/** Bounded candidates include a first-row identity date even when archive doc_date differs. */
function bd_native_candidates(PDO $pdo,string $date,?string $reference,?string $documentId): array {
    $select="SELECT d.id,d.kind,d.source_doc,d.doc_date,d.current_version_id,(SELECT f.row_json FROM `erp_ecount_doc_lines` f WHERE f.version_id=d.current_version_id ORDER BY f.line_no LIMIT 1) AS first_row_json FROM `erp_ecount_documents` d";
    if($documentId!==null){$q=$pdo->prepare($select.' WHERE d.id=? LIMIT 1');$q->execute([$documentId]);return $q->fetchAll(PDO::FETCH_ASSOC);}
    $where="d.kind='sale' AND (d.doc_date=? OR d.source_doc REGEXP ? OR EXISTS(SELECT 1 FROM `erp_ecount_doc_lines` f WHERE f.version_id=d.current_version_id AND f.line_no=(SELECT MIN(z.line_no) FROM `erp_ecount_doc_lines` z WHERE z.version_id=d.current_version_id) AND REPLACE(f.row_json,CHAR(92),'') REGEXP ?))";
    $args=[$date,bd_native_date_pattern($date),bd_native_date_pattern($date,false)];
    if($reference!==null){$where="d.kind='sale' AND (d.source_doc=? OR (".substr($where,strlen("d.kind='sale' AND ")).'))';array_unshift($args,$reference);}
    $q=$pdo->prepare($select.' WHERE '.$where.' ORDER BY d.id LIMIT 2001');$q->execute($args);$rows=$q->fetchAll(PDO::FETCH_ASSOC);
    if(count($rows)>2000)throw new LengthException('원본 후보 전표가 하루 조회 한도 2,000건을 넘습니다. 일부 목록으로 표시하지 않았습니다. ERP 원본 ID로 전표를 직접 확인해 주세요.');
    return $rows;
}
function bd_native_read(PDO $pdo,array $query,string $instance): array {
    if(!bd_native_ready($pdo))bd_native_problem('NATIVE_MISSING','현재 회사 ERP에 원본 이관 전표 DB가 없습니다.');
    bd_native_load_helpers();if(!bs_ready($pdo))bd_native_problem('NATIVE_SCHEMA','원본 이관 DB 준비 상태를 기존 ERP에서 확인해 주세요.');
    $scope=$query['scope']??'all';$date=$query['date']??'';$cursor=$query['cursor']??'0';$limit=$query['limit']??'50';
    if(!is_string($scope)||!in_array($scope,['all','invoice','capabilities'],true)||!is_string($date)||!bd_native_date($date)||!is_string($cursor)||!preg_match('/^(0|[1-9][0-9]{0,14})$/D',$cursor)||!is_string($limit)||!ctype_digit($limit)||(int)$limit<1||(int)$limit>500)throw new InvalidArgumentException('원본 전표 조회 범위를 확인해 주세요.');
    $documentId=$query['documentId']??null;if($documentId!==null&&(!is_string($documentId)||!preg_match('/^[1-9][0-9]{0,14}$/D',$documentId)))throw new InvalidArgumentException('ERP 원본 ID를 확인해 주세요.');
    $reference=null;$parts=null;
    if($scope==='invoice'&&$documentId===null){$reference=$query['reference']??'';if(!is_string($reference)||trim($reference)===''||mb_strlen($reference)>100)throw new InvalidArgumentException('ERP 전표번호를 확인해 주세요.');$parts=bd_native_reference_parts($reference);if($parts)$date=$parts['date'];}
    elseif($documentId!==null&&$scope!=='invoice')throw new InvalidArgumentException('원본 ID 조회 항목을 확인해 주세요.');
    $candidates=bd_native_candidates($pdo,$date,$reference,$documentId);$matched=[];
    foreach($candidates as $doc){
        if(($doc['kind']??'')!=='sale'){if($documentId!==null)bd_native_problem('NATIVE_KIND','해당 ERP 원본 ID는 판매전표가 아닙니다.');continue;}
        if($doc['first_row_json']===null)bd_native_problem('NATIVE_LINES','선택한 원본 전표에 보관된 첫 품목 행이 없습니다.');
        $first=bd_native_raw((string)$doc['first_row_json'],'표시 전표번호');$display=bd_native_identity($doc,[$first]);$source=(string)$doc['source_doc'];
        $displayParts=bd_native_reference_parts($display);$sourceParts=bd_native_reference_parts($source);
        if($documentId!==null)$include=true;
        elseif($scope==='invoice'){
            $literal=preg_replace('/\s+/u','',$reference??'');
            $include=preg_replace('/\s+/u','',$display)===$literal||preg_replace('/\s+/u','',$source)===$literal||($parts!==null&&(($displayParts['canonical']??null)===$parts['canonical']||($sourceParts['canonical']??null)===$parts['canonical']));
        }else $include=(string)$doc['doc_date']===$date||($displayParts['date']??null)===$date||($sourceParts['date']??null)===$date;
        if($include){unset($doc['first_row_json']);$matched[]=$doc;}
    }
    $documents=[];
    if($scope!=='capabilities')foreach($matched as $doc)$documents[]=bd_native_materialize($pdo,$doc);
    $snapshot=hash('sha256',json_encode([$instance,'native-archive',$scope,$date,$reference,$documentId,$scope==='capabilities'?$matched:$documents],JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR));
    if(isset($query['snapshot'])&&(!is_string($query['snapshot'])||!hash_equals($snapshot,$query['snapshot'])))throw new DomainException('조회 중 원본 전표 또는 ERP 수정본이 변경되었습니다. 다시 조회해 주세요.');
    $items=array_values(array_filter($documents,static fn($row)=>(int)$row['id']>(int)$cursor));$more=count($items)>(int)$limit;$items=array_slice($items,0,(int)$limit);
    $result=['schema'=>2,'ok'=>true,'kind'=>'sales','scope'=>$scope,'dateMode'=>'reference-or-date','invoiceVersion'=>$scope==='all'?1:2,'sourceSystem'=>'native-archive','instanceId'=>$instance,'snapshot'=>$snapshot,'total'=>count($documents),'cursor'=>$cursor,'nextCursor'=>$more?(string)end($items)['id']:null,'readAt'=>gmdate('Y-m-d\TH:i:s\Z'),'date'=>$query['date'],'excluded'=>['draft'=>0,'canceled'=>0],'items'=>$items];
    if($scope==='capabilities')$result+=['bridgeVersion'=>'1.13.0','referenceLookup'=>true,'matchedSales'=>count($matched),'totalSales'=>(int)$pdo->query("SELECT COUNT(*) FROM `erp_ecount_documents` WHERE kind='sale'")->fetchColumn(),'salesTable'=>'erp_ecount_documents'];
    return $result;
}
