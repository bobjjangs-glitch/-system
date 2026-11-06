<?php
declare(strict_types=1);

/**
 * Read-only projection of the masters used by the installed native sale editor.
 * Native documents live elsewhere; customer/item masters remain erp_partners /
 * erp_items as demonstrated by native_sale_partner_fields and nlv_catalog.
 * Retail/wholesale references have no proven VAT basis and are never advertised
 * as VAT-exclusive automatic line prices.
 */
function bd_native_catalog_dependencies(string $kind): void {
    $requirements = $kind === 'customers'
        ? ['native_sale_partner.php' => 'native_sale_partner_fields']
        : ['statement_print.php' => 'statement_factory_prices'];
    foreach ($requirements as $file => $function) {
        if (function_exists($function)) continue;
        $path = __DIR__ . '/' . $file;
        if (!is_file($path)) bd_native_problem('NATIVE_HELPER_MISSING','회사 ERP의 원본 조회 도우미 '.$file.'를 확인해 주세요.');
        try { @require_once $path; }
        catch(Throwable $error) { bd_native_problem('NATIVE_HELPER_LOAD','회사 ERP의 원본 조회 도우미 '.$file.'와 연결된 파일을 불러오지 못했습니다.'); }
        if (!function_exists($function)) bd_native_problem('NATIVE_HELPER_VERSION','회사 ERP의 원본 조회 도우미 '.$file.' 버전을 확인해 주세요.');
    }
}
function bd_native_catalog_escape(string $value): string {
    return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $value);
}
function bd_native_catalog_columns(PDO $pdo, string $table): array {
    if (!in_array($table, ['erp_partners', 'erp_items'], true)) throw new InvalidArgumentException();
    return $pdo->query('SHOW COLUMNS FROM ' . $table)->fetchAll(PDO::FETCH_COLUMN);
}
function bd_native_catalog_code(string $token): ?string {
    $prefix = defined('PC_PREFIX') ? (string)constant('PC_PREFIX') : 'C';
    $digits = defined('PC_DIGITS') ? (int)constant('PC_DIGITS') : 5;
    if ($digits < 1 || $digits > 30 || !preg_match('/^' . preg_quote($prefix, '/') . '(\d{1,' . $digits . '})$/iD', $token, $match)) return null;
    return strtoupper($prefix) . str_pad($match[1], $digits, '0', STR_PAD_LEFT);
}
function bd_native_catalog_text(mixed $value): string {
    if ($value === null) return '';
    if (!is_scalar($value)) throw new UnexpectedValueException('회사 ERP 목록의 문자열 형식을 확인해 주세요.');
    return (string)$value;
}
function bd_native_catalog_number(mixed $value): int|float|null {
    if ($value === null || $value === '') return null;
    if (!is_scalar($value) || !preg_match('/^\d{1,13}(?:\.\d{1,10})?$/D', (string)$value)) return null;
    $number = (float)$value;
    if (!is_finite($number) || $number < 0 || $number > 1000000000000) return null;
    return floor($number) === $number ? (int)$number : $number;
}
function bd_native_catalog_customer(PDO $pdo, array $row): array {
    // The installed helper is the same one used by trade_api.php?do=sale_header.
    // In particular it applies the verified statement contact/address overrides.
    $row += ['is_credit' => 0, 'ecount_code' => '', 'partner_code' => ''];
    $header = native_sale_partner_fields($pdo, $row);
    if (!is_array($header)) throw new UnexpectedValueException('회사 ERP 거래처 헤더 형식을 확인해 주세요.');
    $safeHeader = [];
    foreach (['partner_code', 'partner_name', 'ceo', 'phone', 'business_no', 'delivery', 'account', 'receivable'] as $field) {
        $safeHeader[$field] = bd_native_catalog_text($header[$field] ?? '');
    }
    return [
        'id' => (string)$row['id'],
        'code' => $safeHeader['partner_code'],
        'name' => $safeHeader['partner_name'],
        'address' => $safeHeader['delivery'],
        'phone' => $safeHeader['phone'],
        'defaultChannel' => in_array($row['default_channel'] ?? '', ['retail', 'wholesale'], true) ? $row['default_channel'] : '',
        'businessNumber' => $safeHeader['business_no'],
        'representative' => $safeHeader['ceo'],
        'nativeHeader' => $safeHeader,
        'catalogSource' => 'native-master',
    ];
}
function bd_native_catalog_product(array $row, array $factories, array $grossQuotes): array {
    $code = bd_native_catalog_text($row['item_code']);
    $quote = $grossQuotes[(int)$row['id']] ?? [];
    if (!is_array($quote)) $quote = [];
    $factory = bd_native_catalog_number($factories[$code] ?? null);
    return [
        'id' => (string)$row['id'], 'code' => $code,
        'name' => bd_native_catalog_text($row['name']),
        'specification' => bd_native_catalog_text($row['spec'] ?? ''),
        'brand' => bd_native_catalog_text($row['brand'] ?? ''),
        'pattern' => bd_native_catalog_text($row['pattern_name'] ?? ''),
        'taxType' => in_array($row['tax_type'] ?? '', ['taxable', 'exempt'], true) ? $row['tax_type'] : null,
        // The real native picker calls these prices references. A separate gross
        // quote is returned by trade_api; no VAT-exclusive basis is established.
        'unitPrice' => null, 'retailPrice' => null, 'wholesalePrice' => null,
        'referenceRetailPrice' => bd_native_catalog_number($row['retail_price'] ?? null),
        'referenceWholesalePrice' => bd_native_catalog_number($row['wholesale_price'] ?? null),
        'referenceGrossPrice' => bd_native_catalog_number($quote['gross'] ?? null),
        'referenceGrossSource' => bd_native_catalog_text($quote['source'] ?? ''),
        'priceBasis' => 'catalog-reference',
        // This helper accepts only explicit source_factory_price_gross evidence.
        'factoryPrice' => $factory, 'listPrice' => $factory,
        'factoryPriceBasis' => $factory === null ? 'unknown' : 'gross-source-proof',
        'catalogSource' => 'native-master',
    ];
}

/** Constant full-projection snapshot, stable numeric cursors and no ERP writes. */
function bd_native_catalog_read(PDO $pdo, string $kind, array $query, string $instance): array {
    $started = microtime(true);
    if (!in_array($kind, ['customers', 'products'], true)) throw new InvalidArgumentException('조회 항목을 확인해 주세요.');
    $cursor = $query['cursor'] ?? '0'; $limit = $query['limit'] ?? '500'; $search = $query['q'] ?? '';
    if (!is_string($cursor) || !preg_match('/^(0|[1-9][0-9]{0,14})$/D', $cursor)
        || !is_string($limit) || !ctype_digit($limit) || (int)$limit < 1 || (int)$limit > 500
        || !is_string($search) || strlen($search) > 400) throw new InvalidArgumentException('조회 범위를 확인해 주세요.');
    $search = trim($search);
    $size = $search !== '' ? min(30, (int)$limit) : (int)$limit;
    $after = (int)$cursor;
    bd_native_catalog_dependencies($kind);
    $table = $kind === 'customers' ? 'erp_partners' : 'erp_items';
    $columns = bd_native_catalog_columns($pdo, $table);
    $where = ['is_active=1']; $args = [];
    if ($kind === 'customers') {
        $where[] = "partner_type IN ('customer','both')";
        $fields = ['name', 'ceo_name', 'phone'];
        foreach (['partner_code', 'ecount_code', 'search_keyword', 'mobile', 'region', 'address'] as $field) if (in_array($field, $columns, true)) $fields[] = $field;
        foreach (array_slice(preg_split('/\s+/u', $search, -1, PREG_SPLIT_NO_EMPTY) ?: [], 0, 5) as $token) {
            $or = []; $values = [];
            foreach ($fields as $field) { $or[] = $field . ' LIKE ?'; $values[] = '%' . bd_native_catalog_escape($token) . '%'; }
            $code = in_array('partner_code', $columns, true) ? bd_native_catalog_code($token) : null;
            if ($code !== null) { $or[] = 'partner_code=?'; $values[] = $code; $or[] = 'partner_code LIKE ?'; $values[] = bd_native_catalog_escape(strtoupper($token)) . '%'; }
            $digits = preg_replace('/\D/', '', $token);
            if ($code === null && $digits !== '' && strlen($digits) >= 3 && in_array('business_no', $columns, true)) { $or[] = 'business_no LIKE ?'; $values[] = '%' . bd_native_catalog_escape($digits) . '%'; }
            $where[] = '(' . implode(' OR ', $or) . ')'; array_push($args, ...$values);
        }
    } elseif ($search !== '') {
        $tire = function_exists('bd_tire_size') ? bd_tire_size($search) : null;
        if ($tire !== null) {
            $wanted = bd_tire_pattern($tire);
            $any = bd_tire_pattern(['[1-9][0-9]{2}', '[1-9][0-9]', '(1[0-9]|2[0-9]|3[0-9]|40)']);
            $where[] = "(UPPER(COALESCE(spec,'')) REGEXP ? OR (NOT (UPPER(COALESCE(spec,'')) REGEXP ?) AND UPPER(COALESCE(name,'')) REGEXP ?))";
            array_push($args, $wanted, $any, $wanted);
        } else {
            foreach (array_slice(preg_split('/\s+/u', $search, -1, PREG_SPLIT_NO_EMPTY) ?: [], 0, 5) as $token) {
                $fields = array_values(array_intersect(['item_code', 'name', 'spec', 'brand', 'pattern_name'], $columns));
                $where[] = '(' . implode(' OR ', array_map(static fn($field) => $field . ' LIKE ?', $fields)) . ')';
                foreach ($fields as $_) $args[] = '%' . bd_native_catalog_escape($token) . '%';
            }
        }
    }
    $predicate = implode(' AND ', $where);
    $count = $pdo->prepare('SELECT COUNT(*) FROM ' . $table . ' WHERE ' . $predicate);
    $count->execute($args); $total = (int)$count->fetchColumn();
    if ($total > 100000) throw new LengthException('ERP 목록이 100,000개를 넘습니다. 검색어로 범위를 줄여 주세요.');
    $statement = $pdo->prepare('SELECT * FROM ' . $table . ' WHERE ' . $predicate . ' ORDER BY id');
    $statement->execute($args);
    $hash = hash_init('sha256');
    hash_update($hash, json_encode([$instance, 'native-master-v1', $kind, $search, $total], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
    $page = []; $read = 0; $previous = 0; $deadline = $started + 12.0;
    $consume = static function(array $projection) use (&$page, &$read, &$previous, $after, $size, $hash, $deadline): void {
        if (microtime(true) >= $deadline) throw new LengthException('ERP 전체 목록의 최신 정보를 확인하는 시간이 초과됐습니다. 기존 목록은 유지되며 검색어로 범위를 줄일 수 있습니다.');
        $id = $projection['id'];
        if (!is_string($id) || !preg_match('/^[1-9][0-9]{0,14}$/D', $id) || (int)$id <= $previous) throw new UnexpectedValueException('회사 ERP 목록의 순번을 확인해 주세요.');
        $previous = (int)$id; $read++;
        hash_update($hash, json_encode($projection, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR) . "\n");
        if ((int)$id > $after && count($page) < $size + 1) $page[] = $projection;
    };
    if ($kind === 'customers') {
        // Every matching projection is hashed, including contact overrides and
        // native header defaults. Only the requested page stays in PHP memory.
        while ($row = $statement->fetch(PDO::FETCH_ASSOC)) $consume(bd_native_catalog_customer($pdo, $row));
    } else {
        $batch = [];
        $flush = static function() use (&$batch, $pdo, $consume): void {
            if (!$batch) return;
            $factories = statement_factory_prices($pdo, array_column($batch, 'item_code'));
            // Only reuse a pricing helper already loaded by the installed ERP;
            // never substitute a remote Ecount call or guess its implementation.
            $gross = function_exists('tp_gross_quotes') ? tp_gross_quotes($pdo, array_column($batch, 'id')) : [];
            foreach ($batch as $row) $consume(bd_native_catalog_product($row, $factories, $gross));
            $batch = [];
        };
        while ($row = $statement->fetch(PDO::FETCH_ASSOC)) { $batch[] = $row; if (count($batch) === 500) $flush(); }
        $flush();
    }
    if ($read !== $total) throw new DomainException('조회 중 ERP 목록이 바뀌었습니다. 다시 확인해 주세요.');
    $snapshot = hash_final($hash);
    if (isset($query['snapshot']) && (!is_string($query['snapshot']) || !hash_equals($snapshot, $query['snapshot']))) throw new DomainException('조회 중 거래처·품목 또는 연결 정보가 바뀌었습니다. 다시 확인해 주세요.');
    $more = count($page) > $size; if ($more) array_pop($page);
    return [
        'schema' => 2, 'ok' => true, 'kind' => $kind,
        'catalogSource' => 'native-master', 'catalogVersion' => 1,
        'snapshotScope' => 'full-native-projection',
        'instanceId' => $instance, 'snapshot' => $snapshot, 'total' => $total,
        'cursor' => $cursor, 'nextCursor' => $more ? (string)end($page)['id'] : null,
        'readAt' => gmdate('Y-m-d\TH:i:s\Z'), 'date' => null,
        'excluded' => ['draft' => 0, 'canceled' => 0], 'items' => $page,
    ];
}
