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
    $code = $kind !== 'products' ? bd_code_column($pdo) : "''";
    $args = []; $excluded = ['draft' => 0, 'canceled' => 0];
    if ($kind === 'customers') {
        $from = 'erp_partners p';
        $where = "p.is_active=1 AND p.partner_type IN ('customer','both')";
        $fields = "p.id, $code, p.name, p.address, p.phone, p.updated_at";
        $select = "p.id, $code AS code, p.name, p.address, p.phone";
        if (trim($q) !== '') {
            $where .= " AND CONCAT_WS(' ', $code, p.name, p.address, p.phone) LIKE ?";
            $args[] = '%' . addcslashes(trim($q), '%_\\') . '%';
        }
        $id = 'p.id';
    } elseif ($kind === 'products') {
        $from = 'erp_items i'; $where = 'i.is_active=1';
        $fields = 'i.id, i.item_code, i.name, i.spec, i.wholesale_price, i.pattern_name, i.tax_type, i.retail_price, i.updated_at';
        $select = 'i.id, i.item_code AS code, i.name, i.spec AS specification, i.wholesale_price AS unitPrice, i.pattern_name AS pattern, i.tax_type AS taxType, i.retail_price AS listPrice';
        if (trim($q) !== '') {
            $where .= " AND CONCAT_WS(' ', i.item_code, i.name, i.spec, i.brand, i.pattern_name) LIKE ?";
            $args[] = '%' . addcslashes(trim($q), '%_\\') . '%';
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
