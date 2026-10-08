# Test cases for tests\sql-cheatsheet.ps1: every command in ref-docs/basic-sql-cheatsheet.md and
# ref-docs/advanced-sql-cheatsheet.md, run as written (DML/DDL as scripts ending in a SELECT), plus edge cases.
# Expected values are worked out by hand from the test data in sql-cheatsheet.ps1. ASCII only.

$R1 = '1|1|John|John|IT|10|80000|NULL|2020-01-15|555-0101|2022-05-01|NULL'
$R2 = '2|2|Jane|Jane|IT|10|65000|1|2021-03-01|NULL|2023-02-01|John'
$R3 = '3|3|Bob|Bob|HR|20|45000|1|2019-07-10|555-0103|2022-12-31|John'
$R4 = '4|4|Alice|Alice|HR|20|55000|3|2022-02-20|NULL|2023-06-15|Bob'
$R5 = '5|5|Jackson|Jackson|Finance|30|40000|1|2018-11-05|555-0105|2021-01-01|John'
$R6 = '6|6|Emma|Emma|Finance|30|72000|5|2023-05-30|NULL|2024-01-10|Jackson'
$R7 = '7|7|Johnson|Johnson|Sales|40|30000|1|2017-09-12|555-0107|2020-03-03|John'
function J { $args -join "`n" }

# ===================== BASIC 1. Data retrieval =====================
T 'b1 SELECT *' 'SELECT * FROM employees;' (J $R1 $R2 $R3 $R4 $R5 $R6 $R7) -Cols 'id,employee_id,name,employee_name,department,department_id,salary,manager_id,hire_date,phone_number,created_at,manager_name'
T 'b1 SELECT cols' 'SELECT name, salary FROM employees;' (J 'John|80000' 'Jane|65000' 'Bob|45000' 'Alice|55000' 'Jackson|40000' 'Emma|72000' 'Johnson|30000') -Cols 'name,salary'
T 'b1 DISTINCT' 'SELECT DISTINCT department FROM employees;' (J 'Finance' 'HR' 'IT' 'Sales') -Sorted
T 'b1 WHERE =' "SELECT name, salary FROM employees WHERE department = 'IT';" (J 'John|80000' 'Jane|65000')
T 'b1 WHERE >' 'SELECT * FROM employees WHERE salary > 50000;' (J $R1 $R2 $R4 $R6)
T 'b1 ORDER BY DESC' 'SELECT * FROM employees ORDER BY salary DESC;' (J $R1 $R6 $R2 $R4 $R3 $R5 $R7)
T 'b1 ORDER BY 2 keys' 'SELECT * FROM employees ORDER BY department ASC, salary DESC;' (J $R6 $R5 $R4 $R3 $R1 $R2 $R7)
T 'b1 LIMIT' 'SELECT * FROM employees LIMIT 5;' (J $R1 $R2 $R3 $R4 $R5)
T 'b1 LIMIT OFFSET' 'SELECT * FROM employees LIMIT 10 OFFSET 5; -- Skip first 5 rows and fetch the next 10' (J $R6 $R7)
T 'b1 LIKE J%' "SELECT * FROM employees WHERE name LIKE 'J%'; -- Starts with J" (J $R1 $R2 $R5 $R7)
T 'b1 LIKE %son' "SELECT * FROM employees WHERE name LIKE '%son'; -- Ends with 'son'" (J $R5 $R7)
T 'b1 IN list' "SELECT * FROM employees WHERE department IN ('HR', 'IT', 'Finance');" (J $R1 $R2 $R3 $R4 $R5 $R6)
T 'b1 BETWEEN' 'SELECT * FROM employees WHERE salary BETWEEN 40000 AND 60000;' (J $R3 $R4 $R5)
T 'b1 IS NULL' 'SELECT * FROM employees WHERE manager_id IS NULL;' (J $R1)
T 'b1 IS NOT NULL' 'SELECT * FROM employees WHERE manager_id IS NOT NULL;' (J $R2 $R3 $R4 $R5 $R6 $R7)
T 'b1 AS column' 'SELECT name AS employee_name, salary AS monthly_income FROM employees;' (J 'John|80000' 'Jane|65000' 'Bob|45000' 'Alice|55000' 'Jackson|40000' 'Emma|72000' 'Johnson|30000') -Cols 'employee_name,monthly_income'
T 'b1 AS table' 'SELECT e.name, e.salary FROM employees AS e;' (J 'John|80000' 'Jane|65000' 'Bob|45000' 'Alice|55000' 'Jackson|40000' 'Emma|72000' 'Johnson|30000') -Cols 'name,salary'
T 'b1 UNION' @'
SELECT name FROM employees WHERE department = 'IT'
UNION
SELECT name FROM employees WHERE department = 'HR';
'@ (J 'Alice' 'Bob' 'Jane' 'John') -Sorted
T 'b1 UNION ALL' @'
SELECT name FROM employees WHERE department = 'IT'
UNION ALL
SELECT name FROM employees WHERE department = 'HR'; -- Allows duplicates
'@ (J 'Alice' 'Bob' 'Jane' 'John') -Sorted
T 'b1 UNION dedupes' "SELECT department FROM employees WHERE salary > 60000 UNION SELECT department FROM employees WHERE department = 'IT'" (J 'Finance' 'IT') -Sorted
T 'b1 UNION ALL keeps' "SELECT department FROM employees WHERE salary > 60000 UNION ALL SELECT department FROM employees WHERE department = 'IT'" (J 'Finance' 'IT' 'IT' 'IT' 'IT') -Sorted
T 'b1 EXISTS' 'SELECT * FROM employees WHERE EXISTS (SELECT * FROM projects WHERE employees.id = projects.employee_id);' (J $R1 $R3 $R6)
T 'b1 NOT EXISTS' 'SELECT * FROM employees WHERE NOT EXISTS (SELECT * FROM projects WHERE employees.id = projects.employee_id);' (J $R2 $R4 $R5 $R7)
T 'b1 GROUP BY' 'SELECT department, COUNT(*) FROM employees GROUP BY department;' (J 'Finance|2' 'HR|2' 'IT|2' 'Sales|1') -Sorted
T 'b1 HAVING (none)' 'SELECT department, COUNT(*) FROM employees GROUP BY department HAVING COUNT(*) > 5;' ''
T 'b1 HAVING' 'SELECT department, COUNT(*) FROM employees GROUP BY department HAVING COUNT(*) > 1;' (J 'Finance|2' 'HR|2' 'IT|2') -Sorted
T 'b1 WITH' @'
WITH high_salary AS (
    SELECT * FROM employees WHERE salary > 60000
)
SELECT * FROM high_salary WHERE department = 'IT';
'@ (J $R1 $R2)

# ===================== BASIC 2. Data manipulation (scripts) =====================
T 'b2 INSERT cols' @'
INSERT INTO employees (name, department, salary) VALUES ('Alice', 'HR', 55000);
SELECT id, name, department, salary FROM employees WHERE name = 'Alice' ORDER BY id;
'@ (J '4|Alice|HR|55000' 'NULL|Alice|HR|55000')
T 'b2 INSERT all cols' @'
CREATE TABLE employees (id INT PRIMARY KEY, name VARCHAR(100), department VARCHAR(50), salary DECIMAL(10, 2), manager_id INT);
INSERT INTO employees VALUES (1, 'Bob', 'IT', 70000, 2);
SELECT * FROM employees;
'@ '1|Bob|IT|70000.00|2' -Bare
T 'b2 INSERT both forms' @'
CREATE TABLE employees (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100), department VARCHAR(50), salary DECIMAL(10, 2), manager_id INT);
INSERT INTO employees VALUES (1, 'Bob', 'IT', 70000, 2);
INSERT INTO employees (name, department, salary) VALUES ('Alice', 'HR', 55000);
SELECT * FROM employees ORDER BY id;
'@ (J '1|Bob|IT|70000.00|2' '2|Alice|HR|55000.00|NULL') -Bare
T 'b2 INSERT PK NULL' @'
CREATE TABLE employees (id INT PRIMARY KEY, name VARCHAR(100), department VARCHAR(50), salary DECIMAL(10, 2), manager_id INT);
INSERT INTO employees (name, department, salary) VALUES ('Alice', 'HR', 55000);
SELECT * FROM employees;
'@ -Error 'CONSTRAINT_NOT_NULL' -Bare
T 'b2 INSERT PK dup' @'
CREATE TABLE employees (id INT PRIMARY KEY, name VARCHAR(100));
INSERT INTO employees VALUES (1, 'Bob');
INSERT INTO employees VALUES (1, 'Ann');
SELECT * FROM employees;
'@ -Error 'CONSTRAINT_UNIQUE' -Bare
T 'b2 UPDATE =' @'
UPDATE employees SET salary = 75000 WHERE name = 'Alice';
SELECT name, salary FROM employees WHERE department = 'HR' ORDER BY name;
'@ (J 'Alice|75000' 'Bob|45000')
T 'b2 UPDATE expr' @'
UPDATE employees SET salary = salary * 1.05 WHERE department = 'IT';
SELECT name, salary FROM employees ORDER BY id;
'@ (J 'John|84000' 'Jane|68250' 'Bob|45000' 'Alice|55000' 'Jackson|40000' 'Emma|72000' 'Johnson|30000')
T 'b2 dataset unchanged' 'SELECT sum(salary) FROM employees' '387000'
T 'b2 DELETE' @'
DELETE FROM employees WHERE name = 'Bob';
SELECT name FROM employees ORDER BY id;
'@ (J 'John' 'Jane' 'Alice' 'Jackson' 'Emma' 'Johnson')
T 'b2 DELETE AND' @'
DELETE FROM employees WHERE department = 'Finance' AND salary < 45000;
SELECT name FROM employees WHERE department = 'Finance';
'@ 'Emma'
T 'b2 DELETE all' "DELETE FROM employees; SELECT count(*) FROM employees" '0'

# ===================== BASIC 3. Aggregates =====================
T 'b3 COUNT(*)' 'SELECT COUNT(*) FROM employees;' '7'
T 'b3 COUNT DISTINCT' 'SELECT COUNT(DISTINCT department) FROM employees;' '4'
T 'b3 MIN' 'SELECT MIN(salary) FROM employees;' '30000'
T 'b3 MAX' "SELECT MAX(salary) FROM employees WHERE department = 'IT';" '80000'
T 'b3 AVG' "SELECT AVG(salary) FROM employees WHERE department = 'HR';" '50000'
T 'b3 SUM' "SELECT SUM(salary) FROM employees WHERE department = 'Finance';" '112000'

# ===================== BASIC 4. Joins =====================
T 'b4 INNER JOIN' @'
SELECT e.name, p.project_name
FROM employees e
INNER JOIN projects p ON e.id = p.employee_id;
'@ (J 'Bob|Hermes' 'Emma|Athena' 'John|Apollo' 'John|Zeus') -Sorted
T 'b4 LEFT JOIN' @'
SELECT e.name, p.project_name
FROM employees e
LEFT JOIN projects p ON e.id = p.employee_id;
'@ (J 'Alice|NULL' 'Bob|Hermes' 'Emma|Athena' 'Jackson|NULL' 'Jane|NULL' 'John|Apollo' 'John|Zeus' 'Johnson|NULL') -Sorted
T 'b4 RIGHT JOIN' @'
SELECT e.name, p.project_name
FROM employees e
RIGHT JOIN projects p ON e.id = p.employee_id;
'@ (J 'Bob|Hermes' 'Emma|Athena' 'John|Apollo' 'John|Zeus' 'NULL|Orphan') -Sorted
T 'b4 FULL JOIN' @'
SELECT e.name, p.project_name
FROM employees e
FULL JOIN projects p ON e.id = p.employee_id;
'@ (J 'Alice|NULL' 'Bob|Hermes' 'Emma|Athena' 'Jackson|NULL' 'Jane|NULL' 'John|Apollo' 'John|Zeus' 'Johnson|NULL' 'NULL|Orphan') -Sorted
T 'b4 Self JOIN' @'
SELECT e1.name AS employee, e2.name AS manager
FROM employees e1
INNER JOIN employees e2 ON e1.manager_id = e2.id;
'@ (J 'Alice|Bob' 'Bob|John' 'Emma|Jackson' 'Jackson|John' 'Jane|John' 'Johnson|John') -Sorted -Cols 'employee,manager'

# ===================== BASIC 5. Views =====================
T 'b5 CREATE VIEW + SELECT' @'
CREATE VIEW high_salary_employees AS
SELECT * FROM employees WHERE salary > 70000;
SELECT * FROM high_salary_employees;
'@ (J $R1 $R6)
T 'b5 DROP VIEW' @'
CREATE VIEW high_salary_employees AS
SELECT * FROM employees WHERE salary > 70000;
DROP VIEW high_salary_employees;
SELECT * FROM high_salary_employees;
'@ -Error 'TABLE_NOT_FOUND'
T 'b5 DROP VIEW missing' 'DROP VIEW high_salary_employees; SELECT 1' -Error 'VIEW_NOT_FOUND'
T 'b5 view sees later changes' @'
CREATE VIEW it_staff AS SELECT name FROM employees WHERE department = 'IT';
INSERT INTO employees (name, department) VALUES ('Zed', 'IT');
SELECT * FROM it_staff;
'@ (J 'Jane' 'John' 'Zed') -Sorted

# ===================== BASIC 6. Table modifications =====================
$create = 'CREATE TABLE employees (id INT PRIMARY KEY, name VARCHAR(100), department VARCHAR(50), salary DECIMAL(10, 2), manager_id INT); INSERT INTO employees VALUES (1, ''Bob'', ''IT'', 70000, 2);'
T 'b6 ALTER ADD' ($create + ' ALTER TABLE employees ADD hire_date DATE; SELECT * FROM employees;') '1|Bob|IT|70000.00|2|NULL' -Cols 'id,name,department,salary,manager_id,hire_date' -Bare
T 'b6 ALTER MODIFY' @'
ALTER TABLE employees MODIFY salary DECIMAL(10, 2);
SELECT name, salary, typeof(salary) FROM employees WHERE id = 1;
'@ 'John|80000.00|DECIMAL(10,2)'
T 'b6 ALTER DROP COLUMN' ($create + ' ALTER TABLE employees ADD hire_date DATE; ALTER TABLE employees DROP COLUMN hire_date; SELECT * FROM employees;') '1|Bob|IT|70000.00|2' -Cols 'id,name,department,salary,manager_id' -Bare
T 'b6 ALTER ADD exists' 'ALTER TABLE employees ADD hire_date DATE; SELECT 1' -Error 'SQL_COLUMNS'
T 'b6 ALTER RENAME COLUMN' 'ALTER TABLE departments RENAME COLUMN department_name TO dname; SELECT dname FROM departments WHERE department_id = 50' 'Legal'

# ===================== BASIC 7. Table creation =====================
T 'b7 CREATE TABLE' @'
CREATE TABLE employees (
    id INT PRIMARY KEY,
    name VARCHAR(100),
    department VARCHAR(50),
    salary DECIMAL(10, 2),
    manager_id INT
);
SELECT * FROM employees;
'@ '' -Cols 'id,name,department,salary,manager_id' -Bare
T 'b7 CREATE TABLE types' @'
CREATE TABLE employees (
    id INT PRIMARY KEY,
    name VARCHAR(100),
    department VARCHAR(50),
    salary DECIMAL(10, 2),
    manager_id INT
);
DESCRIBE SELECT * FROM employees;
'@ (J 'id|INTEGER' 'name|VARCHAR' 'department|VARCHAR' 'salary|DECIMAL(10,2)' 'manager_id|INTEGER') -Bare
T 'b7 CREATE TABLE exists' 'CREATE TABLE employees (id INT); SELECT 1' -Error 'TABLE_EXISTS'
T 'b7 CREATE TABLE AS' 'CREATE TABLE it AS SELECT name FROM employees WHERE department = ''IT''; SELECT * FROM it' (J 'John' 'Jane')
T 'b7 last table is result' "CREATE TABLE t (a INT, b VARCHAR(10)); INSERT INTO t VALUES (1, 'x'), (2, 'y')" (J '1|x' '2|y') -Bare

# ===================== ADVANCED 1. Advanced retrieval =====================
T 'a1 CASE' @'
SELECT employee_name,
       CASE
           WHEN salary >= 50000 THEN 'High'
           WHEN salary >= 30000 THEN 'Medium'
           ELSE 'Low'
       END AS salary_range
FROM employees;
'@ (J 'John|High' 'Jane|High' 'Bob|Medium' 'Alice|High' 'Jackson|Medium' 'Emma|High' 'Johnson|Medium') -Cols 'employee_name,salary_range'
T 'a1 COALESCE' @'
SELECT employee_id, COALESCE(phone_number, 'No Phone') AS contact_info
FROM employees;
'@ (J '1|555-0101' '2|No Phone' '3|555-0103' '4|No Phone' '5|555-0105' '6|No Phone' '7|555-0107')
T 'a1 EXISTS' @'
SELECT customer_name
FROM customers
WHERE EXISTS (SELECT 1 FROM orders WHERE customers.customer_id = orders.customer_id);
'@ (J 'Acme' 'Initech')
T 'a1 ANY' @'
SELECT product_name
FROM products
WHERE price > ANY (SELECT price FROM competitors_products);
'@ (J 'Gadget' 'Doohickey')
T 'a1 ALL' 'SELECT product_name FROM products WHERE price > ALL (SELECT price FROM competitors_products)' 'Doohickey'
T 'a1 ANY empty' 'SELECT product_name FROM products WHERE price > ANY (SELECT price FROM competitors_products WHERE price > 100)' ''
T 'a1 ALL empty' 'SELECT product_name FROM products WHERE price > ALL (SELECT price FROM competitors_products WHERE price > 100)' (J 'Widget' 'Gadget' 'Doohickey')
T 'a1 SOME / = ANY' 'SELECT product_name FROM products WHERE price < SOME (SELECT price FROM competitors_products) OR price = ANY (SELECT 40)' (J 'Widget' 'Gadget' 'Doohickey')
T 'a1 Subquery in SELECT' @'
SELECT employee_name,
       (SELECT department_name FROM departments WHERE departments.department_id = employees.department_id) AS department
FROM employees;
'@ (J 'John|Information Technology' 'Jane|Information Technology' 'Bob|Human Resources' 'Alice|Human Resources' 'Jackson|Finance' 'Emma|Finance' 'Johnson|Sales') -Cols 'employee_name,department'

# ===================== ADVANCED 2. Data modification =====================
T 'a2 MERGE' @'
MERGE INTO target_table AS T
USING source_table AS S
ON T.id = S.id
WHEN MATCHED THEN
    UPDATE SET T.column = S.column
WHEN NOT MATCHED THEN
    INSERT (column1, column2) VALUES (S.column1, S.column2);
SELECT * FROM target_table ORDER BY id;
'@ (J '1|old1|a|x' '2|new2|b|y' 'NULL|NULL|cc|zz')
T 'a2 MERGE delete + insert all' @'
MERGE INTO target_table AS T
USING source_table AS S
ON T.id = S.id
WHEN MATCHED AND S.column = 'new2' THEN DELETE
WHEN NOT MATCHED THEN INSERT (id, column, column1, column2) VALUES (S.id, S.column, S.column1, S.column2)
WHEN NOT MATCHED BY SOURCE THEN UPDATE SET column = 'gone';
SELECT * FROM target_table ORDER BY id;
'@ (J '1|gone|a|x' '3|new3|cc|zz')
T 'a2 MERGE duplicate match' @'
MERGE INTO target_table AS T
USING (SELECT 2 AS id, 'p' AS v UNION ALL SELECT 2, 'q') AS S
ON T.id = S.id
WHEN MATCHED THEN UPDATE SET column = S.v;
SELECT * FROM target_table;
'@ -Error 'MERGE_DUPLICATE'
T 'a2 INSERT INTO SELECT' @'
CREATE TABLE archive_table (id INT, name VARCHAR(50));
INSERT INTO archive_table (id, name)
SELECT id, name FROM active_table
WHERE created_at < '2023-01-01';
SELECT * FROM archive_table ORDER BY id;
'@ (J '1|alpha' '3|gamma')
T 'a2 UPSERT MySQL' @'
CREATE TABLE employees (employee_id INT PRIMARY KEY, employee_name VARCHAR(100));
INSERT INTO employees VALUES (1, 'Jon');
INSERT INTO employees (employee_id, employee_name)
VALUES (1, 'John Doe')
ON DUPLICATE KEY UPDATE employee_name = 'John Doe';
INSERT INTO employees (employee_id, employee_name) VALUES (2, 'Ann') ON DUPLICATE KEY UPDATE employee_name = 'not used';
SELECT * FROM employees ORDER BY employee_id;
'@ (J '1|John Doe' '2|Ann') -Bare
T 'a2 UPSERT VALUES()' @'
CREATE TABLE stock (sku VARCHAR(10) PRIMARY KEY, qty INT);
INSERT INTO stock VALUES ('a', 5), ('b', 1);
INSERT INTO stock VALUES ('a', 3), ('c', 9) ON DUPLICATE KEY UPDATE qty = qty + VALUES(qty);
SELECT * FROM stock ORDER BY sku;
'@ (J 'a|8' 'b|1' 'c|9') -Bare
T 'a2 UPSERT ON CONFLICT' @'
CREATE TABLE stock (sku VARCHAR(10) PRIMARY KEY, qty INT);
INSERT INTO stock VALUES ('a', 5);
INSERT INTO stock VALUES ('a', 7), ('b', 2) ON CONFLICT (sku) DO UPDATE SET qty = EXCLUDED.qty;
INSERT INTO stock VALUES ('b', 99) ON CONFLICT DO NOTHING;
SELECT * FROM stock ORDER BY sku;
'@ (J 'a|7' 'b|2') -Bare
T 'a2 UPSERT no key = insert' @'
INSERT INTO employees (employee_id, employee_name)
VALUES (1, 'John Doe')
ON DUPLICATE KEY UPDATE employee_name = 'John Doe';
SELECT count(*), count(*) FILTER (WHERE employee_name = 'John Doe') FROM employees;
'@ '8|1'
T 'a2 TRUNCATE' 'TRUNCATE TABLE old_data; SELECT count(*) FROM old_data' '0'
T 'a2 TRUNCATE keeps columns' 'TRUNCATE TABLE old_data;' '' -Cols 'id,v'

# ===================== ADVANCED 3. Reporting =====================
T 'a3 GROUP BY HAVING' @'
SELECT department_id, COUNT(*)
FROM employees
GROUP BY department_id
HAVING COUNT(*) > 5;
'@ ''
T 'a3 GROUP BY HAVING >1' 'SELECT department_id, COUNT(*) FROM employees GROUP BY department_id HAVING COUNT(*) > 1' (J '10|2' '20|2' '30|2') -Sorted
T 'a3 ROLLUP' @'
SELECT department, SUM(salary)
FROM employees
GROUP BY ROLLUP (department);
'@ (J 'Finance|112000' 'HR|100000' 'IT|145000' 'Sales|30000' 'NULL|387000') -Sorted -Cols 'department,sum(salary)'
T 'a3 CUBE' @'
SELECT region, product, SUM(sales)
FROM sales
GROUP BY CUBE (region, product);
'@ (J 'East|A|100' 'East|B|200' 'West|A|300' 'West|B|400' 'East|NULL|300' 'West|NULL|700' 'NULL|A|400' 'NULL|B|600' 'NULL|NULL|1000') -Sorted
T 'a3 GROUPING SETS' 'SELECT region, product, SUM(sales), GROUPING(region, product) FROM sales GROUP BY GROUPING SETS ((region), (product), ())' (J 'East|NULL|300|1' 'West|NULL|700|1' 'NULL|A|400|2' 'NULL|B|600|2' 'NULL|NULL|1000|3') -Sorted
T 'a3 ROLLUP 2 cols + ORDER' 'SELECT region, product, SUM(sales) AS s FROM sales GROUP BY ROLLUP (region, product) ORDER BY s DESC LIMIT 3' (J 'NULL|NULL|1000' 'West|NULL|700' 'West|B|400')
T 'a3 PIVOT' @'
SELECT product, [2023], [2024]
FROM (SELECT product, year, revenue FROM sales_data) AS SourceTable
PIVOT (SUM(revenue) FOR year IN ([2023], [2024])) AS PivotTable;
'@ (J 'A|11|20' 'B|5|7') -Sorted -Cols 'product,2023,2024'

# ===================== ADVANCED 4. Joins and subqueries =====================
T 'a4 CROSS JOIN' @'
SELECT p.product_name, c.customer_name
FROM products p
CROSS JOIN customers c;
'@ (J 'Doohickey|Acme' 'Doohickey|Globex' 'Doohickey|Initech' 'Gadget|Acme' 'Gadget|Globex' 'Gadget|Initech' 'Widget|Acme' 'Widget|Globex' 'Widget|Initech') -Sorted
T 'a4 Self Join' @'
SELECT e1.employee_name, e2.manager_name
FROM employees e1
JOIN employees e2 ON e1.manager_id = e2.employee_id;
'@ (J 'Alice|John' 'Bob|NULL' 'Emma|John' 'Jackson|NULL' 'Jane|NULL' 'Johnson|NULL') -Sorted
T 'a4 Correlated Subquery' @'
SELECT employee_id, salary
FROM employees e
WHERE salary > (SELECT AVG(salary) FROM employees WHERE department_id = e.department_id);
'@ (J '1|80000' '4|55000' '6|72000')
T 'a4 IN (SELECT)' 'SELECT name FROM employees WHERE id IN (SELECT employee_id FROM projects)' (J 'John' 'Bob' 'Emma')
T 'a4 IN (SELECT) nulls' 'SELECT name FROM employees WHERE id IN (SELECT manager_id FROM employees)' (J 'John' 'Bob' 'Jackson')
T 'a4 NOT IN (SELECT) with NULL' 'SELECT name FROM employees WHERE id NOT IN (SELECT manager_id FROM employees)' ''
T 'a4 NOT IN (SELECT)' 'SELECT name FROM employees WHERE id NOT IN (SELECT employee_id FROM projects)' (J 'Jane' 'Alice' 'Jackson' 'Johnson')
T 'a4 scalar in WHERE' 'SELECT name FROM employees WHERE salary > (SELECT AVG(salary) FROM employees)' (J 'John' 'Jane' 'Emma')
T 'a4 correlated count' 'SELECT name, (SELECT count(*) FROM projects p WHERE p.employee_id = e.id) AS n FROM employees e' (J 'John|2' 'Jane|0' 'Bob|1' 'Alice|0' 'Jackson|0' 'Emma|1' 'Johnson|0')
T 'a4 scalar many rows' 'SELECT (SELECT name FROM employees) AS n' -Error 'SUBQUERY_MULTIPLE_ROWS'
T 'a4 scalar no FROM' 'SELECT (SELECT max(salary) FROM employees) - (SELECT min(salary) FROM employees) AS spread' '50000'
T 'a4 subquery + GROUP BY' 'SELECT department, count(*) AS n, (SELECT count(*) FROM departments) AS d FROM employees GROUP BY department' (J 'Finance|2|5' 'HR|2|5' 'IT|2|5' 'Sales|1|5') -Sorted

# ===================== ADVANCED 5. Window functions =====================
T 'a5 ROW_NUMBER' @'
SELECT employee_name, ROW_NUMBER() OVER (ORDER BY hire_date) AS row_num
FROM employees;
'@ (J 'Alice|6' 'Bob|3' 'Emma|7' 'Jackson|2' 'Jane|5' 'John|4' 'Johnson|1') -Sorted -Cols 'employee_name,row_num'
T 'a5 RANK' @'
SELECT employee_name, salary, RANK() OVER (ORDER BY salary DESC) AS rank
FROM employees;
'@ (J 'Alice|55000|4' 'Bob|45000|5' 'Emma|72000|2' 'Jackson|40000|6' 'Jane|65000|3' 'John|80000|1' 'Johnson|30000|7') -Sorted -Cols 'employee_name,salary,rank'
T 'a5 RANK ties' 'SELECT employee_name, RANK() OVER (ORDER BY department) AS r FROM employees' (J 'Alice|3' 'Bob|3' 'Emma|1' 'Jackson|1' 'Jane|5' 'John|5' 'Johnson|7') -Sorted
T 'a5 NTILE' @'
SELECT employee_name, salary, NTILE(4) OVER (ORDER BY salary DESC) AS quartile
FROM employees;
'@ (J 'Alice|55000|2' 'Bob|45000|3' 'Emma|72000|1' 'Jackson|40000|3' 'Jane|65000|2' 'John|80000|1' 'Johnson|30000|4') -Sorted

# ===================== ADVANCED 6. CTEs =====================
T 'a6 Simple CTE' @'
WITH DepartmentSales AS (
    SELECT department_id, SUM(sales) AS total_sales
    FROM sales
    GROUP BY department_id
)
SELECT * FROM DepartmentSales;
'@ (J '10|300' '20|300' '30|400') -Sorted -Cols 'department_id,total_sales'
T 'a6 Recursive CTE' @'
WITH RECURSIVE EmployeeHierarchy AS (
    SELECT employee_id, manager_id, employee_name
    FROM employees
    WHERE manager_id IS NULL
    UNION ALL
    SELECT e.employee_id, e.manager_id, e.employee_name
    FROM employees e
    INNER JOIN EmployeeHierarchy h ON e.manager_id = h.employee_id
)
SELECT * FROM EmployeeHierarchy;
'@ (J '1|NULL|John' '2|1|Jane' '3|1|Bob' '4|3|Alice' '5|1|Jackson' '6|5|Emma' '7|1|Johnson') -Sorted -Cols 'employee_id,manager_id,employee_name'
T 'a6 Recursive levels' @'
WITH RECURSIVE h AS (
    SELECT employee_id, employee_name, 1 AS level FROM employees WHERE manager_id IS NULL
    UNION ALL
    SELECT e.employee_id, e.employee_name, h.level + 1 FROM employees e JOIN h ON e.manager_id = h.employee_id
)
SELECT level, count(*) FROM h GROUP BY level ORDER BY level;
'@ (J '1|1' '2|4' '3|2')
T 'a6 Recursive counter' 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 5) SELECT sum(x), count(*) FROM n' '15|5'
T 'a6 Recursive UNION dedupe' 'WITH RECURSIVE n(x) AS (SELECT 1 UNION SELECT (x % 3) + 1 FROM n) SELECT x FROM n ORDER BY x' (J '1' '2' '3')

# ===================== ADVANCED 7. Transactions =====================
T 'a7 BEGIN/COMMIT' @'
BEGIN TRANSACTION;

UPDATE accounts SET balance = balance - 100 WHERE account_id = 1;
UPDATE accounts SET balance = balance + 100 WHERE account_id = 2;

COMMIT;
SELECT * FROM accounts ORDER BY account_id;
'@ (J '1|400' '2|400')
T 'a7 ROLLBACK' @'
BEGIN TRANSACTION;
UPDATE accounts SET balance = balance - 100 WHERE account_id = 1;
UPDATE accounts SET balance = balance + 100 WHERE account_id = 2;
ROLLBACK;
SELECT * FROM accounts ORDER BY account_id;
'@ (J '1|500' '2|300')
T 'a7 TRY/CATCH ok' @'
BEGIN TRY
    BEGIN TRANSACTION;

    -- SQL statements
    UPDATE accounts SET balance = balance - 100 WHERE account_id = 1;
    UPDATE accounts SET balance = balance + 100 WHERE account_id = 2;

    COMMIT;
END TRY
BEGIN CATCH
    ROLLBACK;
    -- Error handling
END CATCH;
SELECT * FROM accounts ORDER BY account_id;
'@ (J '1|400' '2|400')
T 'a7 TRY/CATCH error rolls back' @'
BEGIN TRY
    BEGIN TRANSACTION;
    UPDATE accounts SET balance = balance - 100 WHERE account_id = 1;
    UPDATE accounts SET no_such_column = 1 WHERE account_id = 2;
    COMMIT;
END TRY
BEGIN CATCH
    ROLLBACK;
END CATCH;
SELECT * FROM accounts ORDER BY account_id;
'@ (J '1|500' '2|300')
T 'a7 ERROR_MESSAGE' @'
BEGIN TRY
    THROW 50000, 'Balance too low', 1;
END TRY
BEGIN CATCH
    CREATE TABLE errors AS SELECT ERROR_MESSAGE() AS msg, ERROR_NUMBER() AS num;
END CATCH;
SELECT * FROM errors;
'@ 'Balance too low|50000'
T 'a7 error without TRY' 'UPDATE accounts SET nope = 1; SELECT 1' -Error 'COLUMN_NOT_FOUND'
T 'a7 COMMIT without BEGIN' 'COMMIT; SELECT 1' -Error 'SQL_TRANSACTION'

# ===================== ADVANCED 8. Indexes =====================
T 'a8 CREATE INDEX' 'CREATE INDEX idx_employee_name ON employees(employee_name); SELECT count(*) FROM employees' '7'
T 'a8 CLUSTERED (cheatsheet)' 'CREATE CLUSTERED INDEX idx_department_id ON employees(department_id); SELECT employee_id FROM employees' (J '1' '2' '3' '4' '5' '6' '7')
T 'a8 CLUSTERED orders rows' 'CREATE CLUSTERED INDEX ix_sal ON employees(salary); SELECT employee_id FROM employees' (J '7' '5' '3' '4' '2' '6' '1')
T 'a8 NONCLUSTERED' 'CREATE NONCLUSTERED INDEX idx_salary ON employees(salary); SELECT max(salary) FROM employees' '80000'
T 'a8 DROP INDEX' 'CREATE INDEX idx_employee_name ON employees(employee_name); DROP INDEX idx_employee_name ON employees; SELECT 1' '1'
T 'a8 DROP INDEX missing' 'DROP INDEX idx_employee_name ON employees; SELECT 1' -Error 'INDEX_NOT_FOUND'
T 'a8 UNIQUE INDEX dup' 'CREATE UNIQUE INDEX ux ON employees(department); SELECT 1' -Error 'CONSTRAINT_UNIQUE'
T 'a8 UNIQUE INDEX enforced' 'CREATE UNIQUE INDEX ux ON employees(employee_id); INSERT INTO employees (employee_id) VALUES (3); SELECT 1' -Error 'CONSTRAINT_UNIQUE'

# ===================== extra =====================
T 'x VALUES' "VALUES (1, 'a'), (2, 'b')" (J '1|a' '2|b') -Cols 'column1,column2'
T 'x VALUES table' "SELECT * FROM (VALUES (1, 'a'), (2, 'b')) AS v(n, s) WHERE n > 1" '2|b' -Cols 'n,s'
T 'x SELECT INTO' "SELECT name, salary INTO rich FROM employees WHERE salary > 70000; SELECT * FROM rich ORDER BY salary" (J 'Emma|72000' 'John|80000')
T 'x CHECK' "CREATE TABLE t (a INT CHECK (a > 0)); INSERT INTO t VALUES (1); INSERT INTO t VALUES (-1); SELECT * FROM t" -Error 'CONSTRAINT_CHECK' -Bare
T 'x DEFAULT' "CREATE TABLE t (a INT, b VARCHAR(10) DEFAULT 'none'); INSERT INTO t (a) VALUES (1); INSERT INTO t VALUES (2, DEFAULT); SELECT * FROM t" (J '1|none' '2|none') -Bare
T 'x NOT NULL' "CREATE TABLE t (a INT NOT NULL); INSERT INTO t VALUES (NULL); SELECT * FROM t" -Error 'CONSTRAINT_NOT_NULL' -Bare
T 'x DROP TABLE' "CREATE TABLE t (a INT); DROP TABLE t; SELECT * FROM t" -Error 'TABLE_NOT_FOUND' -Bare
T 'x DROP TABLE IF EXISTS' "DROP TABLE IF EXISTS nothing_here; SELECT 1" '1' -Bare
T 'x DROP dataset hides it' "DROP TABLE old_data; SELECT * FROM old_data" -Error 'TABLE_NOT_FOUND'
T 'x bracket names' 'SELECT [name], [salary] FROM [employees] WHERE [id] = 2' 'Jane|65000'
T 'x list literal still a list' "SELECT count(*) FROM read_parquet(['no_such_folder/x.parquet'])" -Error 'DATASET_NOT_FOUND'
T 'x script error line' "SELECT 1;`nUPDATE employees SET zzz = 1;`nSELECT 2" -Error 'COLUMN_NOT_FOUND'
T 'x no result' "CREATE TABLE t (a INT); DROP TABLE t" -Error 'SQL_NO_RESULT' -Bare
T 'x CREATE OR REPLACE VIEW' "CREATE VIEW v AS SELECT 1 AS a; CREATE OR REPLACE VIEW v AS SELECT 2 AS a; SELECT * FROM v" '2' -Bare
T 'x view columns' "CREATE VIEW v (x, y) AS SELECT name, salary FROM employees WHERE id = 1; SELECT * FROM v" 'John|80000' -Cols 'x,y'
T 'x ALTER TYPE (Postgres)' "ALTER TABLE products ALTER COLUMN price TYPE DECIMAL(6,1); SELECT price FROM products WHERE product_name = 'Gadget'" '25.0'
T 'x ALTER TABLE RENAME TO' "ALTER TABLE old_data RENAME TO older; SELECT count(*) FROM older" '2'

# ===================== Parquet datasets (row groups run on the workers) =====================
# 350k rows in 4 row groups: k = 0..349999, g = k % 7, v = k % 1000.
$pqRel = 'temp/sqltest-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$job = $engine.StartWrite('SELECT range AS k, range % 7 AS g, range % 1000 AS v FROM range(350000)', $noViews, $pqRel, $null, 1, 0)
if (-not $job.WaitDone(120000) -or $job.State -ne 'done') { throw ('Parquet write failed: ' + $job.State + ' ' + $(if ($job.Error) { $job.Error.Message })) }
$views['big'] = "SELECT * FROM read_parquet('" + $pqRel + "')"
$views['grp'] = 'SELECT * FROM (VALUES (0, ''zero''), (1, ''one''), (2, ''two''), (3, ''three''), (4, ''four''), (5, ''five'')) AS t(g, label)'
T 'pq count' 'SELECT count(*), sum(v) FROM big' '350000|174825000'
T 'pq correlated' 'SELECT count(*) FROM big b WHERE v > (SELECT avg(v) FROM big WHERE g = b.g)' '175000'
T 'pq EXISTS' 'SELECT count(*) FROM big b WHERE EXISTS (SELECT 1 FROM grp WHERE grp.g = b.g)' '300000'
T 'pq NOT IN' 'SELECT count(*) FROM big WHERE g NOT IN (SELECT g FROM grp)' '50000'
T 'pq scalar label' 'SELECT (SELECT label FROM grp WHERE grp.g = big.g) AS l, count(*) FROM big GROUP BY 1 ORDER BY 1 NULLS LAST' (J 'five|50000' 'four|50000' 'one|50000' 'three|50000' 'two|50000' 'zero|50000' 'NULL|50000')
T 'pq script' @'
CREATE TABLE small AS SELECT g, count(*) AS n FROM big GROUP BY g;
UPDATE small SET n = n * 2 WHERE g = 6;
SELECT sum(n) FROM small;
'@ '400000'
T 'pq UPDATE dataset copy' 'UPDATE big SET v = 0 WHERE g = 0; SELECT sum(v) FROM big' '149850000'
T 'pq ROLLUP' 'SELECT g, count(*) FROM big WHERE g < 2 GROUP BY ROLLUP (g)' (J '0|50000' '1|50000' 'NULL|100000') -Sorted
$cnt = 0L
$pr = $engine.Preview('CREATE TABLE t AS SELECT * FROM big WHERE g = 3; SELECT k, v FROM t ORDER BY k', $views, 100, 0, [Threading.CancellationToken]::None, [ref]$cnt)
if ($pr.Rows -eq 100 -and $cnt -eq 50000) { $script:pass++ } else { $script:fail++; $script:failed += 'pq Preview'; Write-Host ('FAIL pq Preview: rows ' + $pr.Rows + ', count ' + $cnt) -ForegroundColor Red }
$pr = $engine.Preview('SELECT * FROM big', $views, 100, 0, [Threading.CancellationToken]::None, [ref]$cnt)
if ($pr.Rows -eq 100 -and $cnt -eq 350000) { $script:pass++ } else { $script:fail++; $script:failed += 'pq Preview plain'; Write-Host ('FAIL pq Preview plain: rows ' + $pr.Rows + ', count ' + $cnt) -ForegroundColor Red }
Remove-Item -Recurse -Force (Join-Path $root $pqRel)

# ===================== editor check =====================
function C([string]$name, [string]$sql, [string]$expect) {
  $r = $engine.Check($sql, $views); $e = @($r['errors'])
  $got = if ($e.Count) { '' + $e[0]['code'] + '@' + $e[0]['pos'] + '-' + $e[0]['end'] + ' line ' + $e[0]['line'] } else { 'ok' }
  if ($got -eq $expect) { $script:pass++ } else { $script:fail++; $script:failed += $name; Write-Host "FAIL $name : expected $expect, got $got ($($e[0]['message']))" -ForegroundColor Red }
}
C 'chk ok' 'SELECT name FROM employees' 'ok'
C 'chk syntax' "SELECT name FROM employees WHERE" 'SQL_SYNTAX@27-32 line 1'
C 'chk bad column' "SELECT nmae FROM employees" 'COLUMN_NOT_FOUND@7-11 line 1'
C 'chk bad table' "SELECT *`nFROM employes" 'TABLE_NOT_FOUND@14-22 line 2'
C 'chk script syntax' "UPDATE employees SET salary = 1 WHER id = 2; SELECT 1" 'SQL_SYNTAX@32-36 line 1'
C 'chk script ok' "UPDATE employees SET salary = 1 WHERE id = 2; SELECT * FROM employees" 'ok'
