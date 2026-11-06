<?php
/** Bareun Dispatch v1: read-only queries against the existing tire ERP schema. */
declare(strict_types=1);

function bd_fail(int $status, string $message): void {
    http_response_code($status);
    echo json_encode(['ok' => false, 'error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}
function bd_load_config(string $path): array {
    // Read guarded JSON as data, never through PHP's opcode cache.
    $raw = file_get_contents($path); $prefix = "<?php exit; ?>\n";
    if (!is_string($raw) || strncmp($raw, $prefix, strlen($prefix)) !== 0) throw new RuntimeException('Invalid bridge configuration');
    $config = json_decode(substr($raw, strlen($prefix)), true, 16, JSON_THROW_ON_ERROR);
    if (!is_array($config)) throw new RuntimeException('Invalid bridge configuration');
    return $config;
}
function bd_authorized(array $config, string $token): bool {
    return preg_match('/^[a-f0-9]{64}$/D', $token) === 1
        && isset($config['token_hash'], $config['instance_id'])
        && is_string($config['token_hash']) && is_string($config['instance_id'])
        && preg_match('/^[a-f0-9]{32}$/D', $config['instance_id']) === 1
        && hash_equals($config['token_hash'], hash('sha256', $token));
}
function bd_date(string $date): bool {
    $d = DateTimeImmutable::createFromFormat('!Y-m-d', $date);
    return $d !== false && $d->format('Y-m-d') === $date;
}
function bd_code_column(PDO $pdo): string {
    $names = $pdo->query('SHOW COLUMNS FROM erp_partners')->fetchAll(PDO::FETCH_COLUMN);
    // These are literal, allowlisted column names. Never interpolate request input.
    foreach (['partner_code', 'ecount_code'] as $column) {
        if (in_array($column, $names, true)) return 'p.' . $column;
    }
    return "''";
}
function bd_digest(PDO $pdo, string $from, string $where, array $args, string $fields): array {
    $stmt = $pdo->prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CRC32(CONCAT_WS(CHAR(31), $fields))), 0) AS checksum FROM $from WHERE $where");
    $stmt->execute($args);
    $r = $stmt->fetch(PDO::FETCH_ASSOC);
    return [(int)$r['n'], (string)$r['checksum']];
}
function bd_read(PDO $pdo, string $kind, array $query, string $instance): array {
    if (!in_array($kind, ['customers', 'products', 'sales'], true)) throw new InvalidArgumentException('조회 항목을 확인해 주세요.');
    $cursor = $query['cursor'] ?? '0'; $limit = $query['limit'] ?? '500';
    if (!is_string($cursor) || !preg_match('/^(0|[1-9][0-9]{0,14})$/D', $cursor)
        || !is_string($limit) || !ctype_digit($limit) || (int)$limit < 1 || (int)$limit > 500) throw new InvalidArgumentException('조회 범위를 확인해 주세요.');
    $after = (int)$cursor; $size = (int)$limit;
    $q = $query['q'] ?? ''; $date = $query['date'] ?? '';
    if (!is_string($q) || strlen($q) > 400) throw new InvalidArgumentException('검색어를 줄여 주세요.');
    if ($kind === 'sales' && (!is_string($date) || !bd_date($date))) throw new InvalidArgumentException('판매일자를 YYYY-MM-DD 형식으로 입력해 주세요.');
    if ($kind === 'sales' && in_array(($query['scope'] ?? ''), ['all','invoice'], true)) return bd_sales_documents($pdo, $query, $instance);
    if ($kind === 'sales' && ($query['scope'] ?? '') === 'capabilities') return bd_capabilities($pdo,$query,$instance);
    $code = $kind !== 'products' ? bd_code_column($pdo) : "''";
    $args = []; $excluded = ['draft' => 0, 'canceled' => 0];
    if ($kind === 'customers') {
        $from = 'erp_partners p';
        $where = "p.is_active=1 AND p.partner_type IN ('customer','both')";
        $fields = "p.id, $code, p.name, p.address, p.phone, p.default_channel, p.updated_at";
        $select = "p.id, $code AS code, p.name, p.address, p.phone, p.default_channel AS defaultChannel";
        if (trim($q) !== '') {
            $where .= " AND CONCAT_WS(' ', $code, p.name, p.address, p.phone) LIKE ?";
            $args[] = '%' . addcslashes(trim($q), '%_\\') . '%';
        }
        $id = 'p.id';
    } elseif ($kind === 'products') {
        $from = 'erp_items i'; $where = 'i.is_active=1';
        $fields = 'i.id, i.item_code, i.name, i.spec, i.wholesale_price, i.pattern_name, i.tax_type, i.retail_price, i.updated_at';
        $select = 'i.id, i.item_code AS code, i.name, i.spec AS specification, i.wholesale_price AS unitPrice, i.pattern_name AS pattern, i.tax_type AS taxType, i.retail_price AS listPrice, i.retail_price AS retailPrice, i.wholesale_price AS wholesalePrice';
        $itemCols=bd_columns($pdo,'erp_items');$factory=bd_optional($itemCols,['factory_price','list_price'],'i.','NULL');
        $fields.=", ".$factory;$select.=", ".$factory.' AS factoryPrice';
        if (trim($q) !== '') {
            $sizeParts=bd_tire_size($q);
            if($sizeParts){
                $wanted=bd_tire_pattern($sizeParts);$any=bd_tire_pattern(['[1-9][0-9]{2}','[1-9][0-9]','(1[0-9]|2[0-9]|3[0-9]|40)']);
                $where.=" AND (UPPER(i.spec) REGEXP ? OR (NOT (UPPER(i.spec) REGEXP ?) AND UPPER(i.name) REGEXP ?))";
                array_push($args,$wanted,$any,$wanted);
            }else{
                $where .= " AND CONCAT_WS(' ', i.item_code, i.name, i.spec, i.brand, i.pattern_name) LIKE ?";
                $args[] = '%' . addcslashes(trim($q), '%_\\') . '%';
            }
        }
        $id = 'i.id';
    } else {
        $from = 'erp_trades t LEFT JOIN erp_partners p ON p.id=t.partner_id';
        $where = "t.trade_type='sale' AND t.trade_date=? AND t.status='confirmed'";
        $args = [$date];
        $fields = "t.id, t.trade_no, t.trade_date, t.customer_name, t.total_amount, t.memo, t.updated_at, $code, p.name, p.address, p.phone";
        $tradeCols = $pdo->query('SHOW COLUMNS FROM erp_trades')->fetchAll(PDO::FETCH_COLUMN);
        $shipAddress = in_array('delivery_addr',$tradeCols,true) ? "COALESCE(NULLIF(t.delivery_addr,''),p.address,'')" : "COALESCE(p.address,'')";
        $shipPhone = in_array('delivery_phone',$tradeCols,true) ? "COALESCE(NULLIF(t.delivery_phone,''),p.phone,'')" : "COALESCE(p.phone,'')";
        $shipRecipient = in_array('delivery_recipient',$tradeCols,true) ? "COALESCE(NULLIF(t.delivery_recipient,''),NULLIF(p.name,''),t.customer_name)" : "COALESCE(NULLIF(p.name,''),t.customer_name)";
        $fields .= ', '.$shipAddress.', '.$shipPhone.', '.$shipRecipient;
        $select = "t.id, t.trade_no AS reference, t.trade_date AS saleDate, t.status, $code AS customerCode, $shipRecipient AS recipient, $shipAddress AS address, $shipPhone AS phone, t.total_amount AS amount, t.memo AS notes, t.updated_at AS updatedAt";
        $id = 't.id';
        $st = $pdo->prepare("SELECT status, COUNT(*) AS n FROM erp_trades WHERE trade_type='sale' AND trade_date=? AND status IN ('draft','canceled') GROUP BY status");
        $st->execute([$date]); foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) $excluded[$r['status']] = (int)$r['n'];
    }
    $digest = bd_digest($pdo, $from, $where, $args, $fields);
    $parts = [$instance, $kind, $date, trim($q), $digest];
    if ($kind === 'sales') {
        $digestCols=$pdo->query('SHOW COLUMNS FROM erp_trade_lines')->fetchAll(PDO::FETCH_COLUMN);
        $extraFields='';foreach(['pattern_name','dc_rate','list_price','dispatch_total','dispatch_amount_basis'] as $field)if(in_array($field,$digestCols,true))$extraFields.=',l.'.$field;
        $parts[] = bd_digest($pdo,
            'erp_trade_lines l JOIN erp_trades t ON t.id=l.trade_id LEFT JOIN erp_items i ON i.id=l.item_id',
            $where, $args, 'l.id,l.trade_id,l.line_no,l.item_name,l.spec,l.qty,l.unit_price,l.amount,l.tax_type,l.memo,i.item_code,i.pattern_name'.$extraFields);
    }
    $snapshot = hash('sha256', json_encode($parts));
    if (isset($query['snapshot']) && (!is_string($query['snapshot']) || !hash_equals($snapshot, $query['snapshot']))) throw new DomainException('조회 도중 ERP 자료가 변경되었습니다. 다시 가져와 주세요.');
    $st = $pdo->prepare("SELECT $select FROM $from WHERE $where AND $id > ? ORDER BY $id LIMIT " . ($size + 1));
    $st->execute([...$args, $after]); $rows = $st->fetchAll(PDO::FETCH_ASSOC);
    $more = count($rows) > $size; $rows = array_slice($rows, 0, $size);
    foreach ($rows as &$row) $row['id'] = (string)$row['id']; unset($row);
    if ($kind === 'sales' && $rows) {
        $ids = array_column($rows, 'id'); $holders = implode(',', array_fill(0, count($ids), '?'));
        $lineCols=$pdo->query('SHOW COLUMNS FROM erp_trade_lines')->fetchAll(PDO::FETCH_COLUMN);
        $pattern=in_array('pattern_name',$lineCols,true)?'l.pattern_name':'i.pattern_name';
        $dc=in_array('dc_rate',$lineCols,true)?'l.dc_rate / 100':'NULL';
        $list=in_array('list_price',$lineCols,true)?'l.list_price':'NULL';
        $gross=in_array('dispatch_total',$lineCols,true)?'l.dispatch_total':'NULL';
        $basis=in_array('dispatch_amount_basis',$lineCols,true)&&in_array('dispatch_total',$lineCols,true)?"CASE WHEN l.dispatch_total IS NULL THEN 'supply' ELSE l.dispatch_amount_basis END":"'supply'";
        $st = $pdo->prepare("SELECT l.id, l.trade_id, l.item_id AS erpItemId, l.item_name AS name, l.spec AS specification, l.qty AS quantity, l.unit_price AS unitPrice, l.amount AS supplyAmount, l.tax_type AS taxType, l.memo AS remarks, $pattern AS pattern, $dc AS discountRate, $list AS listPrice, $gross AS totalAmount, $basis AS amountBasis, COALESCE(i.item_code,'') AS code FROM erp_trade_lines l LEFT JOIN erp_items i ON i.id=l.item_id WHERE l.trade_id IN ($holders) ORDER BY l.trade_id,l.line_no,l.id LIMIT 10001");
        $st->execute($ids); $lines = $st->fetchAll(PDO::FETCH_ASSOC);
        if (count($lines) > 10000) throw new LengthException('품목이 너무 많습니다. 조회 범위를 줄여 주세요.');
        $byId = []; foreach ($lines as $line) { $tradeId = $line['trade_id']; unset($line['trade_id']); $line['id'] = (string)$line['id']; $line['erpItemId']=(string)$line['erpItemId']; $byId[$tradeId][] = $line; }
        foreach ($rows as &$row) $row['items'] = $byId[$row['id']] ?? []; unset($row);
    }
    return ['schema' => 1, 'ok' => true, 'kind' => $kind, 'instanceId' => $instance, 'snapshot' => $snapshot,
        'total' => $digest[0], 'cursor' => (string)$after, 'nextCursor' => $more ? (string)end($rows)['id'] : null,
        'readAt' => gmdate('Y-m-d\TH:i:s\Z'), 'date' => $kind === 'sales' ? $date : null,
        'excluded' => $excluded, 'items' => $rows];
}

/** Public business fields only; never include database configuration, costs or account credentials. */
function bd_columns(PDO $pdo,string $table): array {
    if(!in_array($table,['erp_items','erp_trades','erp_trade_lines','erp_partners'],true))throw new InvalidArgumentException();
    return $pdo->query('SHOW COLUMNS FROM '.$table)->fetchAll(PDO::FETCH_COLUMN);
}
function bd_optional(array $cols,array $names,string $prefix,string $fallback="''"): string {
    foreach($names as $name)if(in_array($name,$cols,true))return $prefix.$name;
    return $fallback;
}
function bd_supplier(): array {
    $c=cfg('company',[]);if(!is_array($c))$c=[];
    return ['name'=>(string)($c['name']??''),'businessNumber'=>(string)($c['biz_no']??''),'representative'=>(string)($c['ceo']??''),'address'=>(string)($c['address']??''),'phone'=>(string)($c['tel']??'')];
}
function bd_sales_documents(PDO $pdo,array $query,string $instance): array {
    $date=$query['date'];$after=(int)($query['cursor']??'0');$size=(int)($query['limit']??'50');
    $tc=bd_columns($pdo,'erp_trades');$lc=bd_columns($pdo,'erp_trade_lines');$ic=bd_columns($pdo,'erp_items');$pc=bd_columns($pdo,'erp_partners');
    $code=bd_code_column($pdo);$from='erp_trades t LEFT JOIN erp_partners p ON p.id=t.partner_id';
    $scope=$query['scope']??'all';
    if($scope==='invoice'){
        $reference=$query['reference']??'';
        if(!is_string($reference)||strlen($reference)>60||!preg_match('/^[A-Za-z0-9][A-Za-z0-9.\/_-]*$/D',$reference))throw new InvalidArgumentException('전표번호를 확인해 주세요.');
        $exact=$pdo->prepare("SELECT COUNT(*) FROM erp_trades WHERE trade_type='sale' AND trade_no=?");$exact->execute([$reference]);
        $aliases=(int)$exact->fetchColumn()>0?[$reference]:bd_reference_aliases($reference);
        $where="t.trade_type='sale' AND t.trade_no IN (".implode(',',array_fill(0,count($aliases),'?')).")";$args=$aliases;
    }else{$where="t.trade_type='sale' AND (DATE(t.trade_date)=? OR t.trade_no REGEXP ?)";$args=[$date,bd_reference_date_pattern($date)];}
    $addr=in_array('delivery_addr',$tc,true)?"COALESCE(NULLIF(t.delivery_addr,''),p.address,'')":"COALESCE(p.address,'')";
    $phone=in_array('delivery_phone',$tc,true)?"COALESCE(NULLIF(t.delivery_phone,''),p.phone,'')":"COALESCE(p.phone,'')";
    $recipient=in_array('delivery_recipient',$tc,true)?"COALESCE(NULLIF(t.delivery_recipient,''),NULLIF(p.name,''),t.customer_name,'')":"COALESCE(NULLIF(p.name,''),t.customer_name,'')";
    $pay=bd_optional($tc,['pay_method'],'t.');$cancel=bd_optional($tc,['cancel_reason'],'t.');
    $fields="t.id,t.trade_no,t.trade_date,t.status,t.channel,t.partner_id,t.customer_name,t.vehicle_no,t.supply_amount,t.vat_amount,t.total_amount,t.memo,t.updated_at,$code,p.name,p.business_no,p.ceo_name,p.address,p.phone,$addr,$phone,$recipient,$pay,$cancel";
    $headers=bd_digest($pdo,$from,$where,$args,$fields);
    $pattern=in_array('pattern_name',$lc,true)?"COALESCE(NULLIF(l.pattern_name,''),i.pattern_name,'')":"COALESCE(i.pattern_name,'')";
    $itemCode=in_array('item_code',$lc,true)?"COALESCE(NULLIF(l.item_code,''),i.item_code,'')":"COALESCE(i.item_code,'')";
    $factory=in_array('list_price',$lc,true)?'l.list_price':bd_optional($ic,['factory_price','list_price'],'i.','NULL');
    if(in_array('dispatch_price_version',$lc,true)&&in_array('dispatch_factory_price',$lc,true))$factory="CASE WHEN l.dispatch_price_version=1 THEN l.dispatch_factory_price ELSE $factory END";
    $dc=in_array('dc_rate',$lc,true)?'l.dc_rate / 100':'NULL';
    $gross=in_array('dispatch_total',$lc,true)?'l.dispatch_total':'NULL';
    $lineFields="l.id,l.trade_id,l.line_no,l.item_id,l.item_name,l.spec,l.tax_type,l.qty,l.unit_price,l.amount,l.memo,$pattern,$itemCode,$factory,$dc,$gross";
    $linesDigest=bd_digest($pdo,'erp_trade_lines l JOIN erp_trades t ON t.id=l.trade_id LEFT JOIN erp_items i ON i.id=l.item_id',$where,$args,$lineFields);
    $supplier=bd_supplier();$snapshot=hash('sha256',json_encode([$instance,$date,$scope,$query['reference']??'',$headers,$linesDigest,$supplier]));
    if(isset($query['snapshot'])&&(!is_string($query['snapshot'])||!hash_equals($snapshot,$query['snapshot'])))throw new DomainException('조회 중 판매전표가 바뀌었습니다. 다시 가져와 주세요.');
    $st=$pdo->prepare("SELECT t.id,t.trade_no AS reference,DATE_FORMAT(t.trade_date,'%Y-%m-%d') AS saleDate,t.status,t.channel,t.partner_id AS erpCustomerId,t.customer_name AS customerName,t.vehicle_no AS vehicleNo,t.supply_amount AS supplyAmount,t.vat_amount AS vatAmount,t.total_amount AS amount,t.memo AS notes,$code AS customerCode,$addr AS address,$phone AS phone,$recipient AS recipient,$pay AS paymentMethod,$cancel AS cancelReason,COALESCE(p.name,t.customer_name,'') AS buyerName,COALESCE(p.business_no,'') AS buyerBusinessNumber,COALESCE(p.ceo_name,'') AS buyerRepresentative,COALESCE(p.address,'') AS buyerAddress,COALESCE(p.phone,'') AS buyerPhone FROM $from WHERE $where AND t.id>? ORDER BY t.id LIMIT ".($size+1));
    $st->execute(array_merge($args,[$after]));$rows=$st->fetchAll(PDO::FETCH_ASSOC);$more=count($rows)>$size;if($more)array_pop($rows);
    if($rows){$ids=array_column($rows,'id');$marks=implode(',',array_fill(0,count($ids),'?'));
        $st=$pdo->prepare("SELECT l.id,l.trade_id,l.line_no AS lineNo,l.item_id AS erpItemId,l.item_name AS name,l.spec AS specification,l.qty AS quantity,l.unit_price AS unitPrice,l.amount AS supplyAmount,l.tax_type AS taxType,l.memo AS remarks,$pattern AS pattern,$itemCode AS code,$factory AS factoryPrice,$dc AS discountRate,$gross AS totalAmount FROM erp_trade_lines l LEFT JOIN erp_items i ON i.id=l.item_id WHERE l.trade_id IN ($marks) ORDER BY l.trade_id,l.line_no,l.id LIMIT 10001");$st->execute($ids);$lines=$st->fetchAll(PDO::FETCH_ASSOC);if(count($lines)>10000)throw new LengthException('전표 품목이 너무 많습니다.');
        $by=[];foreach($lines as $l){$tid=$l['trade_id'];unset($l['trade_id']);$l['id']=(string)$l['id'];$l['erpItemId']=(string)$l['erpItemId'];$l['amountBasis']=$l['totalAmount']===null?'supply':'total';$l['listPrice']=$l['factoryPrice'];$by[$tid][]=$l;}
        foreach($rows as &$r){$r['id']=(string)$r['id'];$r['erpCustomerId']=(string)$r['erpCustomerId'];$r['items']=$by[$r['id']]??[];$r['supplier']=$supplier;$r['buyer']=['name'=>$r['buyerName'],'businessNumber'=>$r['buyerBusinessNumber'],'representative'=>$r['buyerRepresentative'],'address'=>$r['buyerAddress'],'phone'=>$r['buyerPhone']];foreach(['buyerName','buyerBusinessNumber','buyerRepresentative','buyerAddress','buyerPhone'] as $k)unset($r[$k]);}unset($r);
    }
    return ['schema'=>2,'ok'=>true,'kind'=>'sales','dateMode'=>'reference-or-date','scope'=>$scope,'invoiceVersion'=>$scope==='invoice'?2:1,'instanceId'=>$instance,'snapshot'=>$snapshot,'total'=>$headers[0],'cursor'=>(string)$after,'nextCursor'=>$more?(string)end($rows)['id']:null,'readAt'=>gmdate('Y-m-d\TH:i:s\Z'),'date'=>$date,'excluded'=>['draft'=>0,'canceled'=>0],'items'=>$rows];
}

function bd_tire_size(string $q): ?array {
    $q=strtoupper(mb_convert_kana(trim($q),'as','UTF-8'));
    if(!preg_match('/^(\d{3})\s*(?:[\/ -])?\s*(\d{2})\s*(?:ZR|R|Z|[-\s])?\s*(\d{2})$/D',$q,$m))return null;
    if((int)$m[1]<100||(int)$m[2]<10||(int)$m[3]<10||(int)$m[3]>40)return null;
    return [$m[1],$m[2],$m[3]];
}
function bd_tire_pattern(array $p): string {
    return '(^|[^0-9])'.$p[0].'[[:space:]]*[/-]?[[:space:]]*'.$p[1].'[[:space:]]*(ZR|R|Z)?[[:space:]-]*'.$p[2].'([^0-9]|$)';
}
function bd_reference_date_pattern(string $date): string {
    $d=new DateTimeImmutable($date);$m=(int)$d->format('n');$day=(int)$d->format('j');
    $month=$m<10?'0?'.$m:(string)$m;$dom=$day<10?'0?'.$day:(string)$day;
    return '^((SL-)?'.$d->format('Ymd').'|('.$d->format('Y').'|'.$d->format('y').')[/.-]'.$month.'[/.-]'.$dom.')-[0-9]+$';
}
function bd_reference_aliases(string $ref): array {
    if(!preg_match('/^(.+)-(\d{1,12})$/D',$ref,$m))return [$ref];
    $part=str_replace(['/','.'],'-',$m[1]);
    if(preg_match('/^(\d{4})(\d{2})(\d{2})$/D',$part,$d))$date=$d[1].'-'.$d[2].'-'.$d[3];
    elseif(preg_match('/^(\d{2}|\d{4})-(\d{1,2})-(\d{1,2})$/D',$part,$d))$date=(strlen($d[1])===2?'20':'').$d[1].'-'.str_pad($d[2],2,'0',STR_PAD_LEFT).'-'.str_pad($d[3],2,'0',STR_PAD_LEFT);
    else return [$ref];
    if(!bd_date($date))return [$ref];$day=new DateTimeImmutable($date);$seq=ltrim($m[2],'0');if($seq==='')$seq='0';
    return array_values(array_unique([$ref,$day->format('Ymd').'-'.$seq,$day->format('Y/m/d').'-'.$seq,$day->format('y/m/d').'-'.$seq,'SL-'.$day->format('Ymd').'-'.str_pad($seq,4,'0',STR_PAD_LEFT)]));
}
function bd_capabilities(PDO $pdo,array $query,string $instance):array {
    $date=$query['date'];
    $st=$pdo->prepare("SELECT COUNT(*) FROM erp_trades WHERE trade_type='sale' AND (DATE(trade_date)=? OR trade_no REGEXP ?)");$st->execute([$date,bd_reference_date_pattern($date)]);
    $matched=(int)$st->fetchColumn();
    return ['schema'=>2,'ok'=>true,'kind'=>'sales','scope'=>'capabilities','invoiceVersion'=>2,'bridgeVersion'=>'1.11.0','referenceLookup'=>true,'compactTireSearch'=>true,'verticalInvoice'=>true,'instanceId'=>$instance,'snapshot'=>hash('sha256',$instance.$date),'total'=>0,'cursor'=>'0','nextCursor'=>null,'readAt'=>gmdate('Y-m-d\TH:i:s\Z'),'date'=>$date,'excluded'=>['draft'=>0,'canceled'=>0],'items'=>[],'matchedSales'=>$matched,'totalSales'=>(int)$pdo->query("SELECT COUNT(*) FROM erp_trades WHERE trade_type='sale'")->fetchColumn()];
}
