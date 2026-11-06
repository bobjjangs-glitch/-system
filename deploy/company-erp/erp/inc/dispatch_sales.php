<?php
declare(strict_types=1);
function bds_columns(PDO $pdo, string $table): array {
    if (!in_array($table, ['erp_trades','erp_trade_lines','erp_items'], true)) throw new RuntimeException();
    return $pdo->query('SHOW COLUMNS FROM ' . $table)->fetchAll(PDO::FETCH_COLUMN);
}
function bds_install(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS erp_dispatch_requests (request_key CHAR(36) PRIMARY KEY, request_hash CHAR(64) NOT NULL, trade_id BIGINT UNSIGNED NULL, response_json LONGTEXT NULL, created_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $changes = [
        'erp_trade_lines'=>['item_code'=>"VARCHAR(100) NOT NULL DEFAULT ''",'pattern_name'=>"VARCHAR(80) NOT NULL DEFAULT ''",'list_price'=>'BIGINT NOT NULL DEFAULT 0','dc_rate'=>'INT NOT NULL DEFAULT 0','dispatch_factory_price'=>'BIGINT NULL','dispatch_price_version'=>'TINYINT NOT NULL DEFAULT 0','dispatch_total'=>'BIGINT NULL','dispatch_amount_basis'=>"VARCHAR(12) NOT NULL DEFAULT 'unit'"],
        'erp_trades'=>['delivery_addr'=>"VARCHAR(500) NOT NULL DEFAULT ''",'delivery_phone'=>"VARCHAR(40) NOT NULL DEFAULT ''",'delivery_recipient'=>"VARCHAR(200) NOT NULL DEFAULT ''"]
    ];
    foreach ($changes as $table=>$cols) { $have=bds_columns($pdo,$table);foreach($cols as $col=>$type)if(!in_array($col,$have,true))$pdo->exec("ALTER TABLE $table ADD COLUMN $col $type"); }
}
function bds_today(): string { return (new DateTimeImmutable('now',new DateTimeZone('Asia/Seoul')))->format('Y-m-d'); }
function bds_max(PDO $pdo,string $date): int {
    $st=$pdo->prepare("SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(trade_no,'-',-1) AS UNSIGNED)),0) FROM erp_trades WHERE trade_type='sale' AND trade_date=? AND trade_no REGEXP '-[0-9]+$'");$st->execute([$date]);return (int)$st->fetchColumn();
}
function bds_context(PDO $pdo,array $config): array {
    $date=bds_today();$prefix=$config['sequence_prefix']??'SL';
    $st=$pdo->prepare('SELECT last_no FROM erp_doc_sequences WHERE prefix=? AND seq_date=?');$st->execute([$prefix,$date]);$next=max((int)$st->fetchColumn(),bds_max($pdo,$date))+1;
    return ['schema'=>2,'ok'=>true,'instanceId'=>$config['instance_id'],'serverDate'=>$date,'nextReference'=>str_replace('-','',$date).'-'.$next,'writeEnabled'=>!empty($config['writer_user_id']),'preview'=>true];
}
function bds_text($v,int $max,bool $required=false): string {if(!is_string($v)||mb_strlen($v)>$max||($required&&trim($v)===''))throw new InvalidArgumentException();return trim($v);}
function bds_won($v): int {if(!is_numeric($v)||!is_finite((float)$v)||(float)$v<0||(float)$v>1000000000000||floor((float)$v)!=(float)$v)throw new InvalidArgumentException();return (int)$v;}
function bds_line(array $line,array $item): array {
    $q=$line['quantity']??null;if(!is_numeric($q)||!is_finite((float)$q)||(float)$q<=0||(float)$q>1000000||abs((float)$q*1000-round((float)$q*1000))>0.00001)throw new InvalidArgumentException();
    $qm=(int)round((float)$q*1000);$basis=$line['amountBasis']??'unit';$tax=(string)$item['tax_type'];
    if(!in_array($basis,['unit','supply','total'],true)||!in_array($tax,['taxable','exempt'],true)||($line['taxType']??$tax)!==$tax)throw new InvalidArgumentException();
    $price=bds_won($line['unitPrice']??null);
    if($basis==='total'){$total=bds_won($line['totalAmount']??null);$net=$tax==='exempt'?$total:intdiv($total*10+5,11);$price=intdiv($net*1000+intdiv($qm,2),$qm);}
    elseif($basis==='supply'){$net=bds_won($line['supplyAmount']??null);$total=$net+($tax==='exempt'?0:intdiv($net+5,10));$price=intdiv($net*1000+intdiv($qm,2),$qm);}
    else{if($price>intdiv(PHP_INT_MAX-500,$qm))throw new InvalidArgumentException();$net=intdiv($qm*$price+500,1000);$total=$net+($tax==='exempt'?0:intdiv($net+5,10));}
    if($net>1000000000000||$total>1000000000000)throw new InvalidArgumentException();
    $rate=$line['discountRate']??null;$bp=0;if($rate!==null){if(!is_numeric($rate)||(float)$rate<0||(float)$rate>100||abs((float)$rate*100-round((float)$rate*100))>0.00001)throw new InvalidArgumentException();$bp=(int)round((float)$rate*100);}
    return ['name'=>bds_text($line['name']??'',200,true),'code'=>(string)$item['item_code'],'erpItemId'=>(string)$item['id'],'specification'=>bds_text($line['specification']??$item['spec'],40),'pattern'=>bds_text($line['pattern']??$item['pattern_name'],80),'quantity'=>$qm/1000,'unitPrice'=>$price,'supplyAmount'=>$net,'totalAmount'=>$total,'taxType'=>$tax,'amountBasis'=>$basis,'discountRate'=>$rate===null?null:$bp/100,'factoryPrice'=>isset($line['factoryPrice'])?bds_won($line['factoryPrice']):null,'listPrice'=>bds_won($line['listPrice']??0),'remarks'=>bds_text($line['remarks']??'',200)];
}
function bds_insert(PDO $pdo,string $table,array $row): void {
    if(!in_array($table,['erp_trades','erp_trade_lines'],true))throw new RuntimeException();
    $cols=array_keys($row);$pdo->prepare("INSERT INTO $table (".implode(',',$cols).') VALUES ('.implode(',',array_fill(0,count($cols),'?')).')')->execute(array_values($row));
}
function bds_create(PDO $pdo,array $config,array $input): array {
    if(empty($config['writer_user_id']))throw new LogicException('WRITE_DISABLED');
    $key=$input['requestId']??'';$p=$input['row']??null;
    if(!is_string($key)||!preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/D',$key)||!is_array($p))throw new InvalidArgumentException();
    $hash=hash('sha256',json_encode($p,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR));$date=bds_today();$now=(new DateTimeImmutable('now',new DateTimeZone('Asia/Seoul')))->format('Y-m-d H:i:s');
    $pdo->beginTransaction();
    try {
        $pdo->prepare('INSERT IGNORE INTO erp_dispatch_requests(request_key,request_hash,created_at) VALUES(?,?,?)')->execute([$key,$hash,$now]);
        $st=$pdo->prepare('SELECT * FROM erp_dispatch_requests WHERE request_key=? FOR UPDATE');$st->execute([$key]);$request=$st->fetch(PDO::FETCH_ASSOC);
        if(!hash_equals($request['request_hash'],$hash))throw new DomainException('REQUEST_CONFLICT');
        if($request['trade_id']!==null){$st=$pdo->prepare("SELECT id FROM erp_trades WHERE id=? AND status!='canceled'");$st->execute([$request['trade_id']]);if(!$st->fetchColumn())throw new DomainException('REQUEST_DELETED');$result=json_decode($request['response_json'],true,512,JSON_THROW_ON_ERROR);$pdo->commit();return $result;}
        $st=$pdo->prepare("SELECT id FROM erp_users WHERE id=? AND is_active=1 AND role IN ('admin','office')");$st->execute([(int)$config['writer_user_id']]);if(!$st->fetchColumn())throw new LogicException('WRITE_DISABLED');
        $pid=$p['erpCustomerId']??'';if(!is_string($pid)||!preg_match('/^[1-9][0-9]{0,14}$/D',$pid))throw new InvalidArgumentException();
        $st=$pdo->prepare("SELECT * FROM erp_partners WHERE id=? AND is_active=1 AND partner_type IN ('customer','both')");$st->execute([$pid]);$partner=$st->fetch(PDO::FETCH_ASSOC);if(!$partner)throw new InvalidArgumentException();
        $recipient=bds_text($p['recipient']??'',100,true);$address=bds_text($p['address']??'',200,true);$phone=bds_text($p['phone']??'',40);$notes=bds_text($p['notes']??'',500);
        $raw=$p['items']??null;if(!is_array($raw)||count($raw)<1||count($raw)>200)throw new InvalidArgumentException();$lines=[];$supply=0;$total=0;
        foreach($raw as $line){if(!is_array($line)||!is_string($line['erpItemId']??null)||!preg_match('/^[1-9][0-9]{0,14}$/D',$line['erpItemId']))throw new InvalidArgumentException();$st=$pdo->prepare('SELECT id,item_code,name,spec,pattern_name,tax_type FROM erp_items WHERE id=? AND is_active=1');$st->execute([$line['erpItemId']]);$item=$st->fetch(PDO::FETCH_ASSOC);if(!$item)throw new InvalidArgumentException();$out=bds_line($line,$item);$lines[]=$out;$supply+=$out['supplyAmount'];$total+=$out['totalAmount'];}
        if($supply>1000000000000||$total>1000000000000)throw new InvalidArgumentException();
        $prefix=$config['sequence_prefix']??'SL';if(!is_string($prefix)||!preg_match('/^[A-Z0-9_]{1,10}$/D',$prefix))throw new RuntimeException();
        // Coordinate with the ERP's native next_no('SL', date) row, and account for existing compact references.
        $pdo->prepare('INSERT INTO erp_doc_sequences(prefix,seq_date,last_no) VALUES(?,?,0) ON DUPLICATE KEY UPDATE last_no=last_no')->execute([$prefix,$date]);
        $st=$pdo->prepare('SELECT last_no FROM erp_doc_sequences WHERE prefix=? AND seq_date=? FOR UPDATE');$st->execute([$prefix,$date]);$next=max((int)$st->fetchColumn(),bds_max($pdo,$date))+1;if($next>999999999999)throw new RuntimeException();
        $pdo->prepare('UPDATE erp_doc_sequences SET last_no=? WHERE prefix=? AND seq_date=?')->execute([$next,$prefix,$date]);$reference=str_replace('-','',$date).'-'.$next;
        $header=['trade_no'=>$reference,'trade_type'=>'sale','channel'=>in_array($partner['default_channel']??'', ['retail','wholesale'],true)?$partner['default_channel']:'wholesale','trade_date'=>$date,'partner_id'=>(int)$pid,'customer_name'=>bds_text($p['invoiceCustomerName']??$recipient,100),'vehicle_no'=>bds_text($p['invoiceVehicleNo']??'',20),'supply_amount'=>$supply,'vat_amount'=>$total-$supply,'total_amount'=>$total,'status'=>'draft','memo'=>$notes,'created_by'=>(int)$config['writer_user_id'],'created_at'=>$now,'updated_at'=>$now];
        $have=bds_columns($pdo,'erp_trades');foreach(['delivery_addr'=>$address,'delivery_phone'=>$phone,'delivery_recipient'=>$recipient] as $col=>$value)if(in_array($col,$have,true))$header[$col]=$value;
        bds_insert($pdo,'erp_trades',$header);$id=(string)$pdo->lastInsertId();$have=bds_columns($pdo,'erp_trade_lines');
        foreach($lines as $i=>$l){$row=['trade_id'=>(int)$id,'line_no'=>$i+1,'item_id'=>(int)$l['erpItemId'],'item_name'=>$l['name'],'spec'=>$l['specification'],'tax_type'=>$l['taxType'],'qty'=>number_format($l['quantity'],3,'.',''),'unit_price'=>$l['unitPrice'],'amount'=>$l['supplyAmount'],'memo'=>$l['remarks']];foreach(['item_code'=>$l['code'],'pattern_name'=>$l['pattern'],'list_price'=>$l['listPrice'],'dc_rate'=>(int)round(($l['discountRate']??0)*100),'dispatch_factory_price'=>$l['factoryPrice'],'dispatch_price_version'=>1,'dispatch_total'=>$l['totalAmount'],'dispatch_amount_basis'=>$l['amountBasis']] as $col=>$value)if(in_array($col,$have,true))$row[$col]=$value;bds_insert($pdo,'erp_trade_lines',$row);}
        $code=$partner['partner_code']??$partner['ecount_code']??'';
        $result=['schema'=>2,'ok'=>true,'instanceId'=>$config['instance_id'],'requestId'=>$key,'sale'=>['id'=>$id,'reference'=>$reference,'saleDate'=>$date,'status'=>'draft','recipient'=>$recipient,'address'=>$address,'phone'=>$phone,'customerCode'=>(string)$code,'erpCustomerId'=>$pid,'notes'=>$notes,'items'=>$lines,'amount'=>$total,'supplyAmount'=>$supply,'vatAmount'=>$total-$supply,'channel'=>$header['channel'],'paymentMethod'=>'','customerName'=>$header['customer_name'],'vehicleNo'=>$header['vehicle_no'],'cancelReason'=>'','supplier'=>bd_supplier(),'buyer'=>['name'=>(string)$partner['name'],'businessNumber'=>(string)($partner['business_no']??''),'representative'=>(string)($partner['ceo_name']??''),'address'=>(string)$partner['address'],'phone'=>(string)$partner['phone']]]];
        $json=json_encode($result,JSON_UNESCAPED_UNICODE|JSON_INVALID_UTF8_SUBSTITUTE|JSON_THROW_ON_ERROR);
        $pdo->prepare('UPDATE erp_dispatch_requests SET trade_id=?,response_json=? WHERE request_key=?')->execute([$id,$json,$key]);
        $pdo->prepare('INSERT INTO erp_audit_logs(user_id,action,target,target_id,detail,ip,created_at) VALUES(?,?,?,?,?,?,?)')->execute([(int)$config['writer_user_id'],'dispatch_sale_create','trade',(int)$id,'request='.$key,substr($_SERVER['REMOTE_ADDR']??'',0,45),$now]);
        $pdo->commit();return $result;
    }catch(Throwable $e){if($pdo->inTransaction())$pdo->rollBack();throw $e;}
}
