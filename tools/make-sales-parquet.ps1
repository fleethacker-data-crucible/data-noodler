# Generates a large random sales parquet file for testing, using the DuckDB CLI.
# Usage: .\make-sales-parquet.ps1 [-Rows 100000000] [-OutFile .\sales_100m.parquet]
param(
    [long]$Rows = 100000000,
    [string]$OutFile = (Join-Path $PSScriptRoot 'sales_100m.parquet'),
    [string]$DuckDbVersion = '1.1.3'
)

$ErrorActionPreference = 'Stop'

# Locate duckdb.exe (PATH first, then local tools folder, else download)
$duck = (Get-Command duckdb -ErrorAction SilentlyContinue).Source
if (-not $duck) {
    $toolDir = Join-Path $PSScriptRoot 'tools\duckdb'
    $duck = Join-Path $toolDir 'duckdb.exe'
    if (-not (Test-Path $duck)) {
        Write-Host "Downloading DuckDB CLI v$DuckDbVersion..."
        New-Item -ItemType Directory -Force $toolDir | Out-Null
        $zip = Join-Path $toolDir 'duckdb.zip'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest "https://github.com/duckdb/duckdb/releases/download/v$DuckDbVersion/duckdb_cli-windows-amd64.zip" -OutFile $zip -UseBasicParsing
        Expand-Archive $zip -DestinationPath $toolDir -Force
        Remove-Item $zip
    }
}

$outSql = ([IO.Path]::GetFullPath($OutFile)) -replace '\\', '/'

$sql = @'
SET preserve_insertion_order = false;
COPY (
WITH base AS (
    SELECT
        i AS sale_id,
        DATE '2021-01-01' + CAST(floor(random() * 1826) AS INTEGER) AS sale_date,
        CAST(floor(random() * 6) AS INTEGER) AS r_idx,
        CAST(floor(random() * 10) AS INTEGER) AS c_idx,
        CAST(1 + floor(random() * 10) AS INTEGER) AS quantity,
        round(1 + random() * 499, 2) AS unit_price,
        CASE WHEN random() < 0.7 THEN 0 ELSE round(random() * 0.4, 2) END AS discount_pct,
        random() < 0.06 AS is_returned,
        random() < 0.35 AS is_online
    FROM range(__ROWS__) t(i)
),
calc AS (
    SELECT *,
        round(quantity * unit_price * (1 - discount_pct), 2) AS sales_amount
    FROM base
)
SELECT
    sale_id,
    sale_date,
    sale_date + to_seconds(CAST(floor(28800 + random() * 46800) AS BIGINT)) AS sale_ts,
    (['North America','South America','Europe','Asia Pacific','Middle East','Africa'])[r_idx + 1] AS region,
    (['USA','Brazil','Germany','Japan','UAE','South Africa'])[r_idx + 1] AS country,
    r_idx * 1000 + CAST(1 + floor(random() * 250) AS INTEGER) AS store_id,
    'Store ' || lpad(CAST(r_idx * 1000 + CAST(1 + floor(random() * 250) AS INTEGER) AS VARCHAR), 5, '0') AS store_name,
    (['Produce','Dairy','Bakery','Meat','Seafood','Frozen','Beverages','Snacks','Household','Personal Care'])[c_idx + 1] AS product_category,
    (['Fresh','Organic','Value','Premium','Imported'])[CAST(1 + floor(random() * 5) AS INTEGER)] AS product_subcategory,
    c_idx * 100000 + CAST(floor(random() * 5000) AS INTEGER) AS product_id,
    'SKU-' || upper(substr(md5(CAST(sale_id AS VARCHAR)), 1, 10)) AS sku,
    (['Acme','Globex','Initech','Umbrella','Stark','Wayne','Hooli','Soylent','Vandelay','Tyrell','Wonka','Cyberdyne'])[CAST(1 + floor(random() * 12) AS INTEGER)] AS brand,
    quantity,
    unit_price,
    discount_pct,
    sales_amount,
    round(sales_amount * 0.08, 2) AS tax_amount,
    round(sales_amount * 1.08, 2) AS total_amount,
    round(sales_amount * (0.45 + random() * 0.35), 2) AS cost_amount,
    round(sales_amount * (0.20 + random() * 0.35), 2) AS profit,
    (['USD','BRL','EUR','JPY','AED','ZAR'])[r_idx + 1] AS currency,
    (['Cash','Credit Card','Debit Card','Mobile Pay','Gift Card','Check'])[CAST(1 + floor(random() * 6) AS INTEGER)] AS payment_method,
    CASE WHEN is_online THEN (['Web','Mobile App','Marketplace'])[CAST(1 + floor(random() * 3) AS INTEGER)] ELSE 'In Store' END AS channel,
    CAST(1 + floor(random() * 5000000) AS INTEGER) AS customer_id,
    (['Consumer','Small Business','Corporate','Government','Student'])[CAST(1 + floor(random() * 5) AS INTEGER)] AS customer_segment,
    CAST(18 + floor(random() * 63) AS INTEGER) AS customer_age,
    (['F','M','X','U'])[CAST(1 + floor(random() * 4) AS INTEGER)] AS customer_gender,
    random() < 0.4 AS loyalty_member,
    CAST(floor(random() * 20000) AS INTEGER) AS loyalty_points,
    CAST(1 + floor(random() * 8000) AS INTEGER) AS salesperson_id,
    CASE WHEN random() < 0.15 THEN 'PROMO' || CAST(CAST(10 + floor(random() * 90) AS INTEGER) AS VARCHAR) ELSE NULL END AS promo_code,
    is_returned,
    CASE WHEN is_returned THEN (['Damaged','Wrong Item','Not Needed','Late Delivery','Defective'])[CAST(1 + floor(random() * 5) AS INTEGER)] ELSE NULL END AS return_reason,
    CASE WHEN is_online THEN (['Standard','Express','Next Day','Pickup'])[CAST(1 + floor(random() * 4) AS INTEGER)] ELSE 'None' END AS shipping_method,
    CASE WHEN is_online THEN round(random() * 25, 2) ELSE 0 END AS shipping_cost,
    CASE WHEN is_online THEN CAST(1 + floor(random() * 10) AS INTEGER) ELSE 0 END AS delivery_days,
    CAST(1 + floor(random() * 40) AS INTEGER) AS warehouse_id,
    (['Low','Medium','High','Critical'])[CAST(1 + floor(random() * 4) AS INTEGER)] AS order_priority,
    CAST(1 + floor(random() * 5) AS TINYINT) AS rating,
    CAST(1 + floor(random() * 30) AS INTEGER) AS basket_size,
    is_online,
    CASE WHEN is_online THEN (['Desktop','iOS','Android','Tablet'])[CAST(1 + floor(random() * 4) AS INTEGER)] ELSE 'POS' END AS device_type,
    (['Sunny','Cloudy','Rain','Snow','Windy','Fog'])[CAST(1 + floor(random() * 6) AS INTEGER)] AS weather,
    round(-10 + random() * 45, 1) AS temperature_c,
    random() < 0.03 AS holiday_flag,
    'Q' || CAST(quarter(sale_date) AS VARCHAR) || '-' || CAST(year(sale_date) AS VARCHAR) AS fiscal_quarter,
    dayname(sale_date) AS day_of_week,
    round(-60 + random() * 120, 6) AS latitude,
    round(-180 + random() * 360, 6) AS longitude,
    CASE WHEN random() < 0.02 THEN 'Customer comment ' || CAST(sale_id AS VARCHAR) ELSE NULL END AS notes
FROM calc
) TO '__OUT__' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 1000000);
'@

$sql = $sql.Replace('__ROWS__', [string]$Rows).Replace('__OUT__', $outSql)
$sqlFile = Join-Path ([IO.Path]::GetTempPath()) 'make_sales_parquet.sql'
[IO.File]::WriteAllText($sqlFile, $sql, [Text.Encoding]::ASCII)

Write-Host "Generating $Rows rows -> $OutFile"
$sw = [Diagnostics.Stopwatch]::StartNew()
& $duck ':memory:' -c ".read '$($sqlFile -replace '\\', '/')'"
if ($LASTEXITCODE -ne 0) { throw "DuckDB failed with exit code $LASTEXITCODE" }
Remove-Item $sqlFile
$sw.Stop()

$size = (Get-Item $OutFile).Length / 1GB
Write-Host ("Done in {0:N1}s, {1:N2} GB" -f $sw.Elapsed.TotalSeconds, $size)
