# Generates a big, realistic sales dataset (50 columns) as Parquet (Snappy, which the engine reads) or CSV for stress-testing Data Noodler, using the DuckDB CLI
# (tools\duckdb\duckdb.exe, downloaded if missing; dev tool only, not part of the app).
# The data is shaped to look right on charts:
#   - 5 years of orders (2021-2025) with growth (more orders every year), yearly seasonality (summer dip, Nov/Dec peak),
#     weekend lift and holiday spikes (Black Friday week, Christmas week)
#   - 8 regions / 50 states / 200 stores; 25 categories / 2,000 products where a few best sellers carry most sales;
#     prices tied to the product; 1M customers; ~5% NULLs in a few columns; free-text notes
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-sales-csv.ps1 [-Rows 100000000] [-OutFile x.parquet | x.csv]
# Format from the file extension. 100M rows: about 10 GB as Parquet, about 30 GB as CSV. ASCII only (Windows PowerShell 5.1).
param(
    [long]$Rows = 100000000,
    [string]$OutFile = (Join-Path $PSScriptRoot 'sales_100m_50col.parquet'),
    [string]$DuckDbVersion = '1.1.3'
)
$ErrorActionPreference = 'Stop'

$duck = Join-Path $PSScriptRoot 'duckdb\duckdb.exe'
if (-not (Test-Path $duck)) {
    $dir = Split-Path $duck
    Write-Host "Downloading DuckDB CLI v$DuckDbVersion..."
    New-Item -ItemType Directory -Force $dir | Out-Null
    $zip = Join-Path $dir 'duckdb.zip'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest "https://github.com/duckdb/duckdb/releases/download/v$DuckDbVersion/duckdb_cli-windows-amd64.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath $dir -Force
    Remove-Item $zip
}

$out = ([IO.Path]::GetFullPath($OutFile)) -replace '\\', '/'
$isPq = $OutFile -match '\.(parquet|pq)$'
$need = [long]($Rows * $(if ($isPq) { 110 } else { 320 }))
$drive = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($OutFile))
$free = (New-Object IO.DriveInfo($drive)).AvailableFreeSpace
Write-Host ("{0:N0} rows -> {1} (about {2:N1} GB; {3:N1} GB free on {4})" -f $Rows, $out, ($need / 1GB), ($free / 1GB), $drive)
if ($free -lt $need * 1.1) { throw "Not enough free disk space for about $([Math]::Round($need / 1GB, 1)) GB." }

$sql = @'
SET preserve_insertion_order = false;
COPY (
WITH b AS (
    SELECT i AS order_id,
        -- growth: later days are picked more often (about 2.2x more orders in 2025 than 2021)
        CAST(floor(1826 * pow(random(), 0.72)) AS INTEGER) AS d,
        floor(2000 * pow(random(), 2.6)) AS p,          -- product: a few best sellers carry most orders
        CAST(floor(random() * 200) AS INTEGER) AS s,    -- store
        random() AS r1, random() AS r2, random() AS r3, random() AS r4, random() AS r5, random() AS r6
    FROM range(__ROWS__) t(i)
),
c AS (
    SELECT *, DATE '2021-01-01' + d AS order_date,
        CAST(p AS INTEGER) AS product_id,
        CAST(p AS INTEGER) % 25 AS cat,
        s % 8 AS reg
    FROM b
),
f AS (
    SELECT *,
        -- seasonality: summer dip, Nov / Dec peak, weekend lift, Black Friday and Christmas weeks
        (1 + 0.18 * cos(2 * pi() * (dayofyear(order_date) - 15) / 365.0)
           + CASE WHEN month(order_date) = 12 THEN 0.45 WHEN month(order_date) = 11 THEN 0.25 ELSE 0 END
           + CASE WHEN dayofweek(order_date) IN (0, 6) THEN 0.22 ELSE 0 END
           + CASE WHEN month(order_date) = 11 AND day(order_date) BETWEEN 22 AND 30 THEN 0.6 ELSE 0 END
           + CASE WHEN month(order_date) = 12 AND day(order_date) BETWEEN 18 AND 24 THEN 0.5 ELSE 0 END) AS season,
        round(4 + (hash(product_id) % 19600) / 100.0 + cat * 3.5, 2) AS list_price,
        CAST(1 + floor(pow(r1, 2.2) * 12) AS INTEGER) AS qty0
    FROM c
),
g AS (
    SELECT *,
        GREATEST(1, CAST(round(qty0 * season) AS INTEGER)) AS quantity,
        CASE WHEN r2 < 0.62 THEN 0 ELSE round(0.05 + r2 * 0.30, 2) END AS discount_pct
    FROM f
),
h AS (
    SELECT *,
        round(list_price * (0.92 + r3 * 0.12), 2) AS unit_price
    FROM g
),
k AS (
    SELECT *,
        round(quantity * unit_price, 2) AS gross,
        round(quantity * unit_price * discount_pct, 2) AS discount_amount,
        round(quantity * unit_price * (1 - discount_pct), 2) AS revenue
    FROM h
)
SELECT
    order_id,
    order_date,
    order_date + to_seconds(CAST(floor(28800 + r4 * 46800) AS BIGINT)) AS order_ts,
    CAST(8 + floor(r4 * 13) AS INTEGER) AS order_hour,
    year(order_date) AS order_year,
    'Q' || quarter(order_date) AS order_quarter,
    strftime(order_date, '%Y-%m') AS order_month,
    dayname(order_date) AS order_weekday,
    (['Northeast','Southeast','Midwest','Southwest','Mountain','Pacific','Northwest','Great Lakes'])[reg + 1] AS region,
    'USA' AS country,
    (['NY','FL','IL','TX','CO','CA','WA','MI','MA','GA','OH','AZ','UT','OR','PA','NC','MN','NV','NJ','VA','TN','MO','WI','IN','KY',
      'SC','AL','LA','OK','KS','IA','AR','MS','NE','NM','ID','WV','HI','NH','ME','MT','RI','DE','SD','ND','AK','VT','WY','CT','MD'])[s % 50 + 1] AS state,
    s + 1 AS store_id,
    'Store ' || lpad(CAST(s + 1 AS VARCHAR), 3, '0') AS store_name,
    CASE WHEN r5 < 0.58 THEN 'In Store' WHEN r5 < 0.85 THEN 'Web' WHEN r5 < 0.96 THEN 'Mobile App' ELSE 'Marketplace' END AS channel,
    CASE WHEN r6 < 0.46 THEN 'Credit Card' WHEN r6 < 0.70 THEN 'Debit Card' WHEN r6 < 0.85 THEN 'Mobile Pay' WHEN r6 < 0.95 THEN 'Cash' ELSE 'Gift Card' END AS payment_method,
    CAST(1 + floor(random() * 1000000) AS INTEGER) AS customer_id,
    (['Consumer','Consumer','Consumer','Small Business','Corporate','Government'])[CAST(1 + floor(random() * 6) AS INTEGER)] AS customer_segment,
    CAST(18 + floor(random() * 63) AS INTEGER) AS customer_age,
    (['F','M','F','M','X'])[CAST(1 + floor(random() * 5) AS INTEGER)] AS customer_gender,
    CASE WHEN random() < 0.55 THEN 'None' WHEN random() < 0.6 THEN 'Silver' WHEN random() < 0.75 THEN 'Gold' ELSE 'Platinum' END AS loyalty_tier,
    (['Electronics','Computers','Phones','Audio','Cameras','Appliances','Kitchen','Furniture','Bedding','Bath',
      'Garden','Tools','Automotive','Sports','Outdoors','Toys','Games','Books','Music','Movies',
      'Clothing','Shoes','Jewelry','Beauty','Grocery'])[cat + 1] AS category,
    (['Basic','Standard','Premium','Pro','Eco'])[CAST(product_id % 5 AS INTEGER) + 1] AS subcategory,
    product_id + 1 AS product_id,
    (['Acme','Globex','Initech','Umbrella','Stark','Wayne','Hooli','Soylent','Vandelay','Tyrell','Wonka','Cyberdyne'])[CAST(product_id % 12 AS INTEGER) + 1]
        || ' ' || (['Basic','Standard','Premium','Pro','Eco'])[CAST(product_id % 5 AS INTEGER) + 1] || ' ' || lpad(CAST(product_id + 1 AS VARCHAR), 4, '0') AS product_name,
    (['Acme','Globex','Initech','Umbrella','Stark','Wayne','Hooli','Soylent','Vandelay','Tyrell','Wonka','Cyberdyne'])[CAST(product_id % 12 AS INTEGER) + 1] AS brand,
    'SKU-' || lpad(CAST(product_id + 1 AS VARCHAR), 5, '0') AS sku,
    quantity,
    unit_price,
    list_price,
    discount_pct,
    discount_amount,
    revenue,
    round(revenue * 0.07, 2) AS tax,
    CASE WHEN r5 < 0.58 THEN 0 ELSE round(4.99 + quantity * 0.5, 2) END AS shipping,
    round(revenue * 1.07 + CASE WHEN r5 < 0.58 THEN 0 ELSE 4.99 + quantity * 0.5 END, 2) AS total,
    round(revenue * (0.52 + r3 * 0.18), 2) AS cost,
    round(revenue - revenue * (0.52 + r3 * 0.18), 2) AS profit,
    CASE WHEN revenue = 0 THEN NULL ELSE round(1 - (0.52 + r3 * 0.18), 4) END AS margin_pct,
    random() < 0.055 AS is_returned,
    CASE WHEN random() < 0.055 THEN (['Damaged','Wrong item','Not as described','Changed mind','Late delivery'])[CAST(1 + floor(random() * 5) AS INTEGER)] ELSE NULL END AS return_reason,
    discount_pct > 0 AS is_promo,
    CASE WHEN discount_pct > 0 THEN 'PROMO' || CAST(10 + CAST(discount_pct * 100 AS INTEGER) AS VARCHAR) ELSE NULL END AS promo_code,
    CAST(1 + floor(random() * 4000) AS INTEGER) AS salesperson_id,
    (['WH-East','WH-South','WH-Central','WH-West','WH-North'])[CAST(reg % 5 AS INTEGER) + 1] AS warehouse,
    CASE WHEN r5 < 0.58 THEN 'Pickup' WHEN r4 < 0.7 THEN 'Ground' WHEN r4 < 0.92 THEN 'Express' ELSE 'Overnight' END AS ship_mode,
    CASE WHEN r5 < 0.58 THEN 0 ELSE CAST(1 + floor(r4 * 7) AS INTEGER) END AS ship_days,
    order_date + CAST(CASE WHEN r5 < 0.58 THEN 0 ELSE 1 + floor(r4 * 7) END AS INTEGER) AS delivery_date,
    CASE WHEN random() < 0.30 THEN CAST(1 + floor(pow(random(), 0.4) * 5) AS INTEGER) ELSE NULL END AS rating,
    'USD' AS currency,
    CASE WHEN random() < 0.05 THEN NULL WHEN random() < 0.85 THEN '' ELSE
        (['Gift wrap requested','Leave at back door','Customer called about delivery','Price match applied','Bulk order, check stock',
          'Repeat customer','Delivered to neighbor','Signature required'])[CAST(1 + floor(random() * 8) AS INTEGER)] END AS notes
FROM k
) TO '__OUT__' (__FMT__);
'@
$fmt = if ($isPq) { 'FORMAT PARQUET, COMPRESSION SNAPPY, ROW_GROUP_SIZE 100000' } else { "HEADER, DELIMITER ','" }   # the engine rejects ZSTD Parquet
$sql = $sql.Replace('__ROWS__', [string]$Rows).Replace('__OUT__', $out).Replace('__FMT__', $fmt)
$sw = [Diagnostics.Stopwatch]::StartNew()
$sql | & $duck
if ($LASTEXITCODE -ne 0) { throw "DuckDB failed (exit $LASTEXITCODE)." }
$fi = Get-Item ([IO.Path]::GetFullPath($OutFile))
Write-Host ("Done in {0:N0} s: {1:N0} rows, {2:N2} GB ({3:N0} MB/s)" -f $sw.Elapsed.TotalSeconds, $Rows, ($fi.Length / 1GB), ($fi.Length / 1MB / [Math]::Max(0.001, $sw.Elapsed.TotalSeconds)))
